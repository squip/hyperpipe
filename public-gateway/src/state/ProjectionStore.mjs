class ProjectionStore {
  constructor({ registrationStore, eventLog, logger = console } = {}) {
    this.registrationStore = registrationStore;
    this.eventLog = eventLog;
    this.logger = logger;
    this.started = false;
    this.boundProjectEvent = this.#projectEvent.bind(this);
  }

  start() {
    if (this.started) return;
    if (!this.eventLog) return;
    this.eventLog.on('append', this.boundProjectEvent);
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    this.eventLog?.off?.('append', this.boundProjectEvent);
    this.started = false;
  }

  async rebuildFromLog() {
    if (!this.eventLog) return;
    const events = this.eventLog.list({ sinceSequence: 0, limit: 10_000_000 });
    for (const event of events) {
      // eslint-disable-next-line no-await-in-loop
      await this.#projectEvent(event);
    }
  }

  async #projectEvent(event) {
    const payload = event?.payload || {};
    try {
      switch (event?.eventType) {
        case 'RelayRegistered':
          if (payload.relayKey && payload.record && this.registrationStore?.upsertRelay) {
            await this.registrationStore.upsertRelay(payload.relayKey, payload.record);
          }
          break;
        case 'MirrorManifestUpdated':
          if (payload.relayKey && this.registrationStore?.storeMirrorMetadata) {
            await this.registrationStore.storeMirrorMetadata(payload.relayKey, payload.data || {});
          }
          break;
        case 'OpenJoinPoolUpdated':
          if (payload.relayKey && this.registrationStore?.storeOpenJoinPool) {
            await this.registrationStore.storeOpenJoinPool(payload.relayKey, payload.pool || {});
          }
          break;
        case 'OpenJoinAppendCoresUpdated':
          if (payload.relayKey && this.registrationStore?.storeOpenJoinPool) {
            const currentPool = await this.registrationStore.getOpenJoinPool(payload.relayKey);
            const existingCores = Array.isArray(currentPool?.relayCores) ? currentPool.relayCores : [];
            const nextCores = Array.isArray(payload.relayCores) ? payload.relayCores : [];
            const merged = [...existingCores];
            const seen = new Set(existingCores.map((entry) => entry?.key || entry));
            for (const entry of nextCores) {
              const key = entry?.key || entry;
              if (!key || seen.has(key)) continue;
              seen.add(key);
              merged.push(entry);
            }
            await this.registrationStore.storeOpenJoinPool(payload.relayKey, {
              ...(currentPool || {}),
              relayCores: merged,
              updatedAt: Date.now()
            });
          }
          break;
        case 'ClosedJoinPoolUpdated':
          if (payload.relayKey && this.registrationStore?.storeClosedJoinPool) {
            await this.registrationStore.storeClosedJoinPool(payload.relayKey, payload.pool || {});
          }
          break;
        case 'WriterEnvelopePublished':
          if (payload.relayKey && this.registrationStore?.storeWriterEnvelope) {
            await this.registrationStore.storeWriterEnvelope(payload.relayKey, payload.envelope || {});
          }
          break;
        case 'LeaseCertificateCommitted':
          if (payload.relayKey && this.registrationStore?.storeLeaseCertificate) {
            await this.registrationStore.storeLeaseCertificate(payload.relayKey, payload.certificate || {});
          }
          break;
        case 'RelayAuthorityPolicyUpdated':
          if (payload.relayKey && this.registrationStore?.storeRelayPolicy) {
            await this.registrationStore.storeRelayPolicy(payload.relayKey, payload.policy || {});
          }
          break;
        case 'JoinMaterialBundlePublished':
          if (payload.relayKey && payload.purpose && this.registrationStore?.storeBridgeJoinBundle) {
            await this.registrationStore.storeBridgeJoinBundle(payload.relayKey, payload.purpose, payload.bundle || {});
          }
          break;
        case 'BridgeReceiptCommitted':
          if (payload.relayKey && payload.purpose && this.registrationStore?.storeBridgeReceipt) {
            await this.registrationStore.storeBridgeReceipt(payload.relayKey, payload.purpose, payload.receipt || {});
          }
          break;
        case 'TokenRevoked':
          if (payload.relayKey && this.registrationStore?.clearTokenMetadata) {
            await this.registrationStore.clearTokenMetadata(payload.relayKey);
          }
          break;
        default:
          break;
      }
    } catch (error) {
      this.logger?.warn?.('[ProjectionStore] Failed to project event', {
        eventType: event?.eventType,
        sequence: event?.sequence,
        error: error?.message || error
      });
    }
  }
}

export default ProjectionStore;
