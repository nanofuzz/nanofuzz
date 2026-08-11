import * as Config from "../../Config";

/**
 * Type for individual leaders and auxiliary data.
 */
export type Leader<T> = { leader: T; score: number; focus: number };

/**
 * Running list of "interesting" inputs.
 */ 
export class Leaderboard<T> {
  private _leaders: Leader<T>[] = []; // List of leaders
  private _outdated_leaders: Leader<T>[] = []; // List of outdated leaders that don't conform to the current specs
  private _minScore = 0.9999; // initial minimum score
  private _minScoreIdx = -1; // index of leader with the minimum score
  private _slots = 200; // maximum number of slots in leaderboard
  private _initialFocus = 200; // Amount of focus for new leaders
  private _focusDecay = 1; // Amount of focus to decrement on each random leader selection

  /**
   * Create a new list of interesting inputs
   *
   * @param `slots` optional maximum number of slots to maintain on the leaderbord
   */
  public constructor(slots?: number) {
    if (slots && slots <= 0) {
      throw new Error("Leaderboard slots must be >= 0");
    }
    if (slots !== undefined) {
      this._slots = slots;
    }
    this.loadConfig();
  } // fn: constructor

  /**
   * (Re)loads the leaderboard's configurable parameters from the
   * `nanofuzz.generators.*` configuration.
   */
  public loadConfig(): void {
    this._minScore = Config.get<number>(
      "nanofuzz.generators.leaderboardMinScore",
      0.9999
    );
    this._initialFocus = Config.get<number>(
      "nanofuzz.generators.leaderboardInitialFocus",
      200
    );
    this._focusDecay = Config.get<number>(
      "nanofuzz.generators.leaderboardFocusDecay",
      1
    );
  } // fn: loadConfig

  /**
   * Returns the leaderboard's name (currently just the constructor name)
   */
  public get name(): string {
    return this.constructor.name;
  } // property: get name

  /**
   * Returns the number of slots in the leaderboard
   */
  public get slots(): number {
    return this._slots;
  } // property: get slots

  /**
   * Updates the leaderboard's minimum score and the leaderboard
   * position with that minimum score.
   */
  protected _updateMinScore(): void {
    // Only update the minimum score if the leaderboard is full
    if (this._leaders.length === this._slots) {
      this._minScore = Number.MAX_VALUE;
      this._leaders.forEach((l, i) => {
        if (l.score < this._minScore) {
          this._minScore = l.score;
          this._minScoreIdx = i;
        }
      });
    }
  } // fn: updateMinScore

  /**
   * Posts a leader and a score to the leaderboard if the score
   * is above the minimum score.
   *
   * @param `leader` the leader to post to the board
   * @param `score` the score of that leader
   * @returns `true` if posted to leaderboard
   */
  public postScore(leader: T, score: number): boolean {
    // Only post scores > minimum score
    if (score > this._minScore) {
      const thisLeader = {
        leader: structuredClone(leader),
        score,
        focus: this._initialFocus,
      };

      // If the leaderboard is full...
      if (this._leaders.length === this._slots) {
        // ...replace the lowest score with the new higher one
        this._leaders[this._minScoreIdx] = thisLeader;
      } else {
        // ...otherwise add the leader
        this._leaders.push(thisLeader);
      }

      // Re-calculate the minimum score, if necessary
      this._updateMinScore();

      // indicate this input was added to the leaderboard
      return true;
    }

    // not added to leaderboard
    return false;
  } // fn: postScore

  /**
   * Returns length of the leaderboard
   */
  public get length(): number {
    return this._leaders.length;
  } // property: get length]

  /**
   * Get a random leader from the leaderboard. This random selection
   * is biased by recentness, so that more recent additions to the
   * leaderbnoard are more likely to be returned than older ones.
   *
   * @param `prng` pseudo random number generator
   * @returns a random leader
   */
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
    const leader = this._leaders[leaderIdx ?? 0].leader;
    return structuredClone(leader);
  } // fn: getRandomLeader

  /**
   * Returns all the leaders in the leaderboard. Note that the array is in
   * an arbitrary order.
   *
   * @returns array of leaders
   */
  public getLeaders(): { leader: T; score: number }[] {
    return structuredClone(this._leaders);
  } // fn: getLeaders

  /**
   * Filter all the leaders (include outdated leaders) in the leaderboard
   * using `fn`.
   *
   * Leaders satisfy fn are visible to callers, while leaders do not satisfy
   * fn are kept in _outdated_leaders, and later filter() calls might promote
   * to be leaders again.
   *
   * @param fn the predicated used for filtering
   */
  public filter(fn: (leader: { leader: T }) => boolean) {
    const allLeaders = [...this._leaders, ...this._outdated_leaders];
    this._leaders = allLeaders.filter(fn);
    this._outdated_leaders = allLeaders.filter((leader) => !fn(leader));
  } // fn: validate
} // class: Leaderboard
