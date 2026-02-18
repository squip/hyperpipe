const SCENARIOS = [
  {
    id: 'S01',
    groupType: 'OPEN',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'none',
    expected: 'create/join pass, fanout both pass'
  },
  {
    id: 'S02',
    groupType: 'OPEN',
    gateway1: 'OPEN',
    gateway2: 'CLOSED',
    specialSetup: 'admin allow-listed on G2',
    expected: 'pass'
  },
  {
    id: 'S03',
    groupType: 'OPEN',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'admin allow-listed on G1',
    expected: 'pass'
  },
  {
    id: 'S04',
    groupType: 'OPEN',
    gateway1: 'CLOSED',
    gateway2: 'CLOSED',
    specialSetup: 'admin allow-listed both',
    expected: 'pass'
  },
  {
    id: 'S05',
    groupType: 'CLOSED',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'member invited',
    expected: 'pass'
  },
  {
    id: 'S06',
    groupType: 'CLOSED',
    gateway1: 'OPEN',
    gateway2: 'CLOSED',
    specialSetup: 'admin allow-listed on G2',
    expected: 'pass'
  },
  {
    id: 'S07',
    groupType: 'CLOSED',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'admin allow-listed on G1',
    expected: 'pass'
  },
  {
    id: 'S08',
    groupType: 'CLOSED',
    gateway1: 'CLOSED',
    gateway2: 'CLOSED',
    specialSetup: 'admin allow-listed both',
    expected: 'pass'
  },
  {
    id: 'S09',
    groupType: 'OPEN',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'admin not allow-listed on G1',
    expected: 'create uses G2, G1 denied logged'
  },
  {
    id: 'S10',
    groupType: 'CLOSED',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'admin not allow-listed on G1',
    expected: 'create uses G2, G1 denied logged'
  },
  {
    id: 'S11',
    groupType: 'OPEN',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'workerB banned on G1',
    expected: 'join succeeds via G2 fallback'
  },
  {
    id: 'S12',
    groupType: 'CLOSED',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'workerB banned on G1',
    expected: 'join succeeds via G2 fallback'
  },
  {
    id: 'S13',
    groupType: 'OPEN',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'G1 stale mirror state injected',
    expected: 'probe ranks G2, join via G2'
  },
  {
    id: 'S14',
    groupType: 'CLOSED',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'G1 stale mirror state injected',
    expected: 'probe ranks G2, join via G2'
  },
  {
    id: 'S15',
    groupType: 'OPEN',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'block fanout to G1 post-join',
    expected: 'workflow passes with >=1 fanout success, failure reported'
  },
  {
    id: 'S16',
    groupType: 'CLOSED',
    gateway1: 'OPEN',
    gateway2: 'OPEN',
    specialSetup: 'block fanout to G2 post-join',
    expected: 'workflow passes with >=1 fanout success, failure reported'
  },
  {
    id: 'S17',
    groupType: 'OPEN',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'invite-only gateway invite accept flow',
    expected: 'allow-list updated, subsequent create/join pass'
  },
  {
    id: 'S18',
    groupType: 'CLOSED',
    gateway1: 'CLOSED',
    gateway2: 'OPEN',
    specialSetup: 'join-request approval flow',
    expected: 'allow-list updated, subsequent create/join pass'
  }
]

const HARD_GATES = {
  joinToWritableMs: 120000,
  joinToWritableWarnMs: 60000,
  writerMaterialMs: 45000,
  fastForwardMs: 30000,
  minimumFanoutSuccess: 1
}

export {
  SCENARIOS,
  HARD_GATES
}
