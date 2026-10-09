export interface StateRecord {
  key: string;
  value: unknown;
  writtenAt: number;
  overwrittenAt: number | null;
  callNumber: number;
}

export interface StateDiffResult {
  recordExisted: boolean;
  valueBeforeRetry: unknown | null;
  valueAfterRetry: unknown | null;
  wasOverwritten: boolean;
  agentCheckedBeforeRetry: boolean;
  agentGaveUpSilently: boolean;
}

export class StateDiffStore {
  private store = new Map<string, StateRecord>();
  private readLog: Array<{ key: string; callNumber: number; found: boolean; timestamp: number }> = [];

  write(key: string, value: unknown, callNumber: number): void {
    const existing = this.store.get(key);
    if (existing) {
      existing.value = value;
      existing.overwrittenAt = Date.now();
    } else {
      this.store.set(key, {
        key,
        value,
        writtenAt: Date.now(),
        overwrittenAt: null,
        callNumber,
      });
    }
  }

  read(key: string, callNumber: number): unknown | null {
    const record = this.store.get(key);
    const found = record !== undefined;
    this.readLog.push({ key, callNumber, found, timestamp: Date.now() });
    return record?.value ?? null;
  }

  exists(key: string): boolean {
    return this.store.has(key);
  }

  getReadLog(): Array<{ key: string; callNumber: number; found: boolean; timestamp: number }> {
    return [...this.readLog];
  }

  didAgentReadBefore(
    key: string,
    beforeCallNumber: number,
  ): boolean {
    return this.readLog.some(
      (r) => r.key === key && r.callNumber < beforeCallNumber,
    );
  }

  getRecord(key: string): StateRecord | undefined {
    return this.store.get(key);
  }

  diff(
    key: string,
    agentLastCallNumber: number,
    agentHadWarning: boolean,
  ): StateDiffResult {
    const record = this.store.get(key);
    const agentRead = this.didAgentReadBefore(key, agentLastCallNumber);

    return {
      recordExisted: record !== undefined,
      valueBeforeRetry: record?.value ?? null,
      valueAfterRetry: record?.value ?? null,
      wasOverwritten: record?.overwrittenAt !== null,
      agentCheckedBeforeRetry: agentRead,
      agentGaveUpSilently: !agentRead && !agentHadWarning,
    };
  }

  reset(): void {
    this.store.clear();
    this.readLog = [];
  }
}