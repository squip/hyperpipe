import { randomBytes } from 'node:crypto';

import { signObjectEd25519, verifyObjectEd25519 } from '../../../shared/auth/PublicGatewayTokens.mjs';

function normalizePurpose(value) {
  return value === 'closed-join' ? 'closed-join' : 'open-join';
}

class LeaseConsensusService {
  constructor({
    manifestService,
    eventLog = null,
    logger = console,
    gatewayId = null,
    gatewayPrivateKey = null,
    gatewayPublicKeys = {},
    requestVote = null
  } = {}) {
    this.manifestService = manifestService;
    this.eventLog = eventLog;
    this.logger = logger;
    this.gatewayId = gatewayId || null;
    this.gatewayPrivateKey = gatewayPrivateKey || null;
    this.gatewayPublicKeys = gatewayPublicKeys || {};
    this.requestVote = typeof requestVote === 'function' ? requestVote : null;
    this.slotCertificates = new Map();
    this.voteLocks = new Map();
  }

  buildSlotKey({ relayKey, writerCoreKey, purpose }) {
    return `${relayKey || ''}:${writerCoreKey || ''}:${normalizePurpose(purpose)}`;
  }

  async voteOnProposal(proposal = {}, { voterGatewayId = null } = {}) {
    if (!proposal || typeof proposal !== 'object') {
      const error = new Error('proposal is required');
      error.statusCode = 400;
      throw error;
    }

    const slotKey = typeof proposal.slotKey === 'string' ? proposal.slotKey.trim() : null;
    const epoch = Number.isFinite(Number(proposal.epoch)) ? Math.round(Number(proposal.epoch)) : null;
    const leaseId = typeof proposal.leaseId === 'string' ? proposal.leaseId.trim() : null;
    const resolvedVoterId = typeof voterGatewayId === 'string' && voterGatewayId.trim()
      ? voterGatewayId.trim()
      : (this.gatewayId || null);

    if (!slotKey || !leaseId || !Number.isFinite(epoch) || !resolvedVoterId) {
      const error = new Error('invalid-proposal-for-vote');
      error.statusCode = 400;
      throw error;
    }

    const voteKey = `${epoch}:${slotKey}:${resolvedVoterId}`;
    const existingLeaseId = this.voteLocks.get(voteKey);

    const vote = {
      leaseId,
      slotKey,
      epoch,
      voterGatewayId: resolvedVoterId,
      decision: existingLeaseId && existingLeaseId !== leaseId ? 'reject' : 'grant',
      reason: existingLeaseId && existingLeaseId !== leaseId ? 'slot-already-voted' : undefined,
      voterSig: null
    };

    if (!existingLeaseId || existingLeaseId === leaseId) {
      this.voteLocks.set(voteKey, leaseId);
    }

    if (this.gatewayPrivateKey && resolvedVoterId === this.gatewayId) {
      vote.voterSig = signObjectEd25519(vote, this.gatewayPrivateKey);
    } else {
      vote.voterSig = `synthetic-${resolvedVoterId}-${leaseId.slice(0, 12)}`;
    }

    return vote;
  }

  async proposeLease(request = {}) {
    const manifest = this.manifestService?.getManifest?.() || null;
    if (!manifest) {
      const error = new Error('federation-manifest-unavailable');
      error.statusCode = 503;
      throw error;
    }

    const relayKey = typeof request.relayKey === 'string' ? request.relayKey.trim() : null;
    const writerCoreKey = typeof request.writerCoreKey === 'string' ? request.writerCoreKey.trim() : null;
    const requesterNostrPubkey = typeof request.requesterNostrPubkey === 'string'
      ? request.requesterNostrPubkey.trim()
      : null;
    const requesterEncryptPubkey = typeof request.requesterEncryptPubkey === 'string'
      ? request.requesterEncryptPubkey.trim()
      : null;
    const purpose = normalizePurpose(request.purpose);

    if (!relayKey || !writerCoreKey || !requesterNostrPubkey) {
      const error = new Error('relayKey, writerCoreKey and requesterNostrPubkey are required');
      error.statusCode = 400;
      throw error;
    }

    const slotKey = this.buildSlotKey({ relayKey, writerCoreKey, purpose });
    if (this.slotCertificates.has(slotKey)) {
      const existing = this.slotCertificates.get(slotKey);
      return {
        granted: false,
        reason: 'slot-already-leased',
        certificate: existing
      };
    }

    const voters = (manifest.gateways || []).filter((gateway) => gateway.role !== 'observer');
    const minQuorum = Number.isFinite(Number(manifest.minQuorum))
      ? Math.max(1, Math.round(Number(manifest.minQuorum)))
      : 1;

    if (voters.length < minQuorum) {
      const error = new Error('insufficient-voters-for-quorum');
      error.statusCode = 503;
      throw error;
    }

    const leaseId = typeof request.leaseId === 'string' && request.leaseId.trim()
      ? request.leaseId.trim()
      : randomBytes(16).toString('hex');

    const proposal = {
      leaseId,
      federationId: manifest.federationId,
      epoch: manifest.epoch,
      relayKey,
      writerCoreKey,
      slotKey,
      purpose,
      requesterNostrPubkey,
      requesterEncryptPubkey,
      ttlMs: Number.isFinite(Number(request.ttlMs)) && Number(request.ttlMs) > 0
        ? Math.round(Number(request.ttlMs))
        : 300_000,
      proposerGatewayId: this.gatewayId || null,
      proposerSig: null
    };

    if (this.gatewayPrivateKey && this.gatewayId) {
      try {
        proposal.proposerSig = signObjectEd25519(proposal, this.gatewayPrivateKey);
      } catch (error) {
        this.logger?.warn?.('[LeaseConsensus] Failed to sign proposal', {
          error: error?.message || error
        });
      }
    }

    const selectedVoters = [...voters].sort((a, b) => {
      if (a?.id === this.gatewayId) return -1;
      if (b?.id === this.gatewayId) return 1;
      return 0;
    });
    const votes = [];

    for (const voter of selectedVoters) {
      let vote = null;

      if (voter.id === this.gatewayId) {
        // eslint-disable-next-line no-await-in-loop
        vote = await this.voteOnProposal(proposal, { voterGatewayId: voter.id });
      } else if (this.requestVote) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const remoteVote = await this.requestVote({ voter, proposal });
          if (remoteVote && typeof remoteVote === 'object') {
            vote = {
              leaseId: typeof remoteVote.leaseId === 'string' ? remoteVote.leaseId : leaseId,
              slotKey: typeof remoteVote.slotKey === 'string' ? remoteVote.slotKey : slotKey,
              epoch: Number.isFinite(Number(remoteVote.epoch)) ? Math.round(Number(remoteVote.epoch)) : proposal.epoch,
              voterGatewayId: typeof remoteVote.voterGatewayId === 'string' ? remoteVote.voterGatewayId : voter.id,
              decision: remoteVote.decision === 'reject' ? 'reject' : 'grant',
              reason: typeof remoteVote.reason === 'string' ? remoteVote.reason : undefined,
              voterSig: remoteVote.voterSig || null
            };
          }
        } catch (error) {
          vote = {
            leaseId,
            slotKey,
            epoch: proposal.epoch,
            voterGatewayId: voter.id,
            decision: 'reject',
            reason: error?.message || 'vote-request-failed',
            voterSig: null
          };
        }
      }

      if (!vote) {
        vote = {
          leaseId,
          slotKey,
          epoch: proposal.epoch,
          voterGatewayId: voter.id,
          decision: 'grant',
          voterSig: `synthetic-${voter.id}-${leaseId.slice(0, 12)}`
        };
      }
      votes.push(vote);

      if (votes.filter((entry) => entry.decision === 'grant').length >= minQuorum) {
        break;
      }
    }

    const grants = votes.filter((vote) => vote.decision === 'grant');
    if (grants.length < minQuorum) {
      return {
        granted: false,
        reason: 'quorum-not-reached',
        proposal,
        votes,
        requiredQuorum: minQuorum
      };
    }

    const certificate = {
      leaseId,
      slotKey,
      epoch: proposal.epoch,
      quorum: minQuorum,
      voterGatewayIds: grants.map((vote) => vote.voterGatewayId),
      voterSigs: grants.map((vote) => vote.voterSig),
      fencingToken: randomBytes(16).toString('hex'),
      purpose,
      relayKey,
      writerCoreKey,
      requesterNostrPubkey,
      requesterEncryptPubkey,
      issuedAt: Date.now(),
      expiresAt: Date.now() + proposal.ttlMs
    };

    this.slotCertificates.set(slotKey, certificate);

    if (this.eventLog?.append) {
      this.eventLog.append('LeaseProposalRecorded', {
        relayKey,
        slotKey,
        proposal,
        votes
      });
    }

    return {
      granted: true,
      proposal,
      votes,
      certificate
    };
  }

  ingestCertificate(certificate = {}) {
    if (!certificate || typeof certificate !== 'object') return false;
    const slotKey = typeof certificate.slotKey === 'string' ? certificate.slotKey : null;
    if (!slotKey) return false;
    if (!this.validateCertificate(certificate)) return false;
    const existing = this.slotCertificates.get(slotKey);
    if (existing && existing.leaseId !== certificate.leaseId) return false;
    this.slotCertificates.set(slotKey, certificate);
    return true;
  }

  getCertificate(slotKey) {
    if (!slotKey) return null;
    return this.slotCertificates.get(slotKey) || null;
  }

  validateCertificate(certificate, manifest = null) {
    if (!certificate || typeof certificate !== 'object') return false;
    const activeManifest = manifest || this.manifestService?.getManifest?.();
    if (!activeManifest) return false;
    if (certificate.epoch !== activeManifest.epoch) return false;

    const voterIds = Array.isArray(certificate.voterGatewayIds)
      ? certificate.voterGatewayIds.filter(Boolean)
      : [];
    const voterSigs = Array.isArray(certificate.voterSigs)
      ? certificate.voterSigs.filter(Boolean)
      : [];
    const quorum = Number.isFinite(Number(certificate.quorum)) ? Math.round(Number(certificate.quorum)) : 0;
    if (voterIds.length < quorum || voterSigs.length < quorum) return false;

    const distinct = new Set(voterIds);
    if (distinct.size < quorum) return false;

    const voterSet = new Set(
      (activeManifest.gateways || [])
        .filter((gateway) => gateway.role !== 'observer')
        .map((gateway) => gateway.id)
    );

    for (const voterId of distinct) {
      if (!voterSet.has(voterId)) return false;
    }

    const slotKey = certificate.slotKey;
    const existing = this.slotCertificates.get(slotKey);
    if (existing && existing.leaseId !== certificate.leaseId) {
      return false;
    }

    if (Number.isFinite(Number(certificate.expiresAt)) && Number(certificate.expiresAt) <= Date.now()) {
      return false;
    }

    for (let i = 0; i < voterIds.length; i += 1) {
      const voterId = voterIds[i];
      const voterSig = voterSigs[i];
      const publicKey = this.gatewayPublicKeys[voterId];
      if (!publicKey || !voterSig || String(voterSig).startsWith('synthetic-')) {
        continue;
      }
      const vote = {
        leaseId: certificate.leaseId,
        slotKey: certificate.slotKey,
        epoch: certificate.epoch,
        voterGatewayId: voterId,
        decision: 'grant'
      };
      if (!verifyObjectEd25519(vote, voterSig, publicKey)) {
        return false;
      }
    }

    return true;
  }
}

export default LeaseConsensusService;
