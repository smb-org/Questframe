type MarkTask = () => Promise<void>;

export class BingoMarkQueue {
  private readonly pending: MarkTask[] = [];
  private active: Promise<void> | null = null;
  private paused = false;

  public get hasWork(): boolean {
    return this.active !== null || this.pending.length > 0;
  }

  public enqueue(task: MarkTask): Promise<void> {
    this.pending.push(task);
    return this.drain();
  }

  public pauseAndClear(): void {
    this.paused = true;
    this.pending.length = 0;
  }

  public waitForActive(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  public resume(): Promise<void> {
    this.paused = false;
    return this.drain();
  }

  private drain(): Promise<void> {
    if (this.active !== null) return this.active;
    if (this.paused) return Promise.resolve();

    const active = (async (): Promise<void> => {
      while (!this.paused && this.pending.length > 0) {
        const task = this.pending.shift();
        if (task !== undefined) await task();
      }
    })();
    this.active = active;
    const finish = (): void => {
      if (this.active !== active) return;
      this.active = null;
      if (!this.paused && this.pending.length > 0) void this.drain();
    };
    void active.then(finish, finish);
    return active;
  }
}
