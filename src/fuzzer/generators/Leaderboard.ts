import * as JSON5 from "json5";

// !!!!!!
export class Leaderboard<T> {
  private _leaders: { leader: T; score: number }[] = []; // !!!!!!
  private _leadersJson: string = JSON5.stringify(this._leaders); // !!!!!!
  private _minScore = -1; // !!!!!!
  private _slots; // 0 = no limit !!!!!!
  private _isDirty = false; // !!!!!!

  // !!!!!!
  public constructor(slots?: number) {
    this._slots = slots ?? 200;
  }

  // !!!!!!
  public postScore(leader: T, score: number): void {
    // Only change the leaderboard if score is > the current minimum
    if (score > this._minScore) {
      // Add the score
      this._leaders.push({
        leader: JSON5.parse(JSON5.stringify(leader)),
        score: score,
      });

      // Indicate that we need to update the leaderboard prior to
      // it being observed
      this._isDirty = true;
    }
  }

  // !!!!!!
  public getLeaders(): typeof this._leaders {
    // Only maintain the leaderboard if it's dirty and
    // it's being observed
    if (this._isDirty) {
      // Sort the leaders in descending order
      this._leaders.sort((a, b) => b.score - a.score);

      // Remove entries beyond the maximum number of slots
      if (this._slots && this._leaders.length > this._slots) {
        this._leaders = this._leaders.slice(
          0,
          this._slots - this._leaders.length
        );
      }

      // Update the minimum score & Json
      this._minScore = this._leaders[this._leaders.length - 1].score;
      this._leadersJson = JSON5.stringify(this._leaders);

      // Mark the leaderboard as not dirty
      this._isDirty = false;
    }

    // Return a copy of the updated leaderboard
    return JSON5.parse(this._leadersJson);
  }
}
