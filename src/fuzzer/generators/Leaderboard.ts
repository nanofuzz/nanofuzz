import * as JSON5 from "json5";

// !!!!!!
export class Leaderboard<T> {
  private _leaders: { leader: T; score: number; focus: number }[] = []; // !!!!!!
  private _minScore = 0.9999; // !!!!!!
  private _minScoreIdx = -1; // !!!!!!
  private _slots = 200; // >= 1 !!!!!!
  private _initialFocus = 200; // !!!!!!
  private _focusDecay = 1; // !!!!!!

  // !!!!!!
  public constructor(slots?: number) {
    if (slots && slots <= 0) {
      throw new Error("Leaderboard slots must be >= 0");
    }
    if (slots !== undefined) {
      this._slots = slots;
    }
  } // !!!!!!

  /**
   * Returns the leaderboard's name
   */
  public get name(): string {
    return this.constructor.name;
  } // !!!!!!

  // !!!!!!
  public get slots(): number {
    return this._slots;
  } // !!!!!!

  // !!!!!!
  private updateMinScore() {
    if (this._leaders.length === this._slots) {
      this._minScore = Number.MAX_VALUE;
      this._leaders.forEach((l, i) => {
        if (l.score < this._minScore) {
          this._minScore = l.score;
          this._minScoreIdx = i;
        }
      });
    }
  } // !!!!!!

  // !!!!!!
  public postScore(leader: T, score: number): void {
    // Only post scores > minimum score
    if (score > this._minScore) {
      const thisLeader = {
        leader: JSON5.parse(JSON5.stringify(leader)),
        score,
        focus: this._initialFocus,
      };
      // If the leaderboard is full...
      if (this._leaders.length === this._slots) {
        // ...replace the lowest score with the new, higher, one
        this._leaders[this._minScoreIdx] = thisLeader;
      } else {
        // ...otherwise add the leader
        this._leaders.push(thisLeader);
      }
      // Re-calculate the minimum score, if necessary
      this.updateMinScore();
    }
  } // !!!!!!

  // !!!!!!
  public get length(): number {
    return this._leaders.length;
  } // !!!!!!

  // !!!!!!
  // weighted by recentness
  public getRandomLeader(prng: seedrandom.prng): T {
    if (!this._leaders.length) {
      throw new Error("Leaderboard is empty");
    }
    const totalScore = this._leaders
      .map((l) => l.focus)
      .reduce((a, b) => a + b);
    let score = prng() * totalScore;
    let leaderIdx: number | undefined;

    this._leaders.forEach((l, i) => {
      score -= l.focus;
      if (leaderIdx === undefined && score <= 0) {
        leaderIdx = i;
      }
      if (l.focus > this._focusDecay + 1) {
        l.focus -= this._focusDecay;
      }
    });

    return JSON5.parse(JSON5.stringify(this._leaders[leaderIdx ?? 0].leader));
  } // !!!!!!

  // !!!!!!
  public getLeaders(): { leader: T; score: number }[] {
    return JSON5.parse(JSON5.stringify(this._leaders));
  } // !!!!!!
} // !!!!!!
