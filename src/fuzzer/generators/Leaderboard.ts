import * as Config from "../../Config";

/**
 * Running list of "interesting" items.
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
    this._updateMinScore();
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
   * Returns the initial focus for new leaders
   */
  public get initialFocus(): number {
    return this._initialFocus;
  } // property: get initialFocus

  /**
   * Returns the focus decay rate
   */
  public get focusDecay(): number {
    return this._focusDecay;
  } // property: get focusDecay

  /**
   * Updates the leaderboard's minimum score and the leaderboard
   * position with that minimum score.
   */
  protected _updateMinScore(): void {
    // Maintain minimum score invariants:
    // - When full (_leaders.length === _slots): _minScore is set to the lowest active leader's score
    //   and _minScoreIdx points to its position, so postScore() replaces the lowest score.
    // - When not full (_leaders.length < _slots): _minScore resets to the configured baseline minimum
    //   (nanofuzz.generators.leaderboardMinScore, default 0.9999) and _minScoreIdx resets to -1
    //   so postScore() appends new leaders into open slots.
    if (this._leaders.length === this._slots && this._slots > 0) {
      this._minScore = this._leaders[0].score;
      this._minScoreIdx = 0;
      this._leaders.forEach((l, i) => {
        if (l.score < this._minScore) {
          this._minScore = l.score;
          this._minScoreIdx = i;
        }
      });
    } else {
      this._minScore = Config.get<number>(
        "nanofuzz.generators.leaderboardMinScore",
        0.9999
      );
      this._minScoreIdx = -1;
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
    const valid = allLeaders.filter(fn);
    const invalid = allLeaders.filter((leader) => !fn(leader));

    if (valid.length > this._slots) {
      // Keep top `_slots` highest-scoring leaders
      valid.sort((a, b) => b.score - a.score);
      this._leaders = valid.slice(0, this._slots);
      this._outdated_leaders = [...valid.slice(this._slots), ...invalid];
    } else {
      this._leaders = valid;
      this._outdated_leaders = invalid;
    }

    this._updateMinScore();
  } // fn: filter

  /**
   * Representation invariant check for the Leaderboard.
   *
   * Invariants maintained by Leaderboard:
   * 1. Capacity Invariant: `_leaders.length <= _slots`. The active leaders array
   *    must never exceed the maximum configured capacity (`_slots`).
   * 2. Leader Index and Minimum Score Invariants:
   *    a. When full (`_leaders.length === _slots` and `_slots > 0`):
   *       - `_minScoreIdx` must be a valid index in `_leaders` (`0 <= _minScoreIdx < _leaders.length`).
   *       - `_minScore` must equal `_leaders[_minScoreIdx].score`.
   *       - Every active leader `l` in `_leaders` must have `l.score >= _minScore`.
   *    b. When not full (`_leaders.length < _slots`):
   *       - `_minScoreIdx` must be `-1`.
   *       - `_minScore` must equal the configured baseline minimum score (0.9999).
   * 3. Structural Invariants: Every leader in `_leaders` and `_outdated_leaders`
   *    must have a valid leader payload, a finite non-NaN score, and a non-negative focus.
   *
   * @returns `true` if all representation invariants hold; `false` otherwise.
   */
  public repOk(): boolean {
    if (this._leaders.length > this._slots) {
      console.error(
        `Leaderboard repOk failed: _leaders.length (${this._leaders.length}) exceeds _slots (${this._slots})`
      );
      return false;
    }

    // Structural checks for active leaders
    for (let i = 0; i < this._leaders.length; i++) {
      const l = this._leaders[i];
      if (
        !l ||
        typeof l.score !== "number" ||
        Number.isNaN(l.score) ||
        typeof l.focus !== "number"
      ) {
        console.error(
          `Leaderboard repOk failed: invalid leader structure at index ${i}`
        );
        return false;
      }
    }

    // Structural checks for outdated leaders
    for (let i = 0; i < this._outdated_leaders.length; i++) {
      const l = this._outdated_leaders[i];
      if (
        !l ||
        typeof l.score !== "number" ||
        Number.isNaN(l.score) ||
        typeof l.focus !== "number"
      ) {
        console.error(
          `Leaderboard repOk failed: invalid outdated leader structure at index ${i}`
        );
        return false;
      }
    }

    if (this._leaders.length === this._slots && this._slots > 0) {
      if (this._minScoreIdx < 0 || this._minScoreIdx >= this._leaders.length) {
        console.error(
          `Leaderboard repOk failed: _minScoreIdx (${this._minScoreIdx}) out of bounds for length (${this._leaders.length})`
        );
        return false;
      }

      const expectedMinScore = this._leaders[this._minScoreIdx].score;
      if (this._minScore !== expectedMinScore) {
        console.error(
          `Leaderboard repOk failed: _minScore (${this._minScore}) does not match _leaders[_minScoreIdx].score (${expectedMinScore})`
        );
        return false;
      }

      for (let i = 0; i < this._leaders.length; i++) {
        if (this._leaders[i].score < this._minScore) {
          console.error(
            `Leaderboard repOk failed: leader at index ${i} has score (${this._leaders[i].score}) below _minScore (${this._minScore})`
          );
          return false;
        }
      }
    } else {
      if (this._minScoreIdx !== -1) {
        console.error(
          `Leaderboard repOk failed: _minScoreIdx (${this._minScoreIdx}) should be -1 when leaderboard is not full`
        );
        return false;
      }

      const baselineMinScore = Config.get<number>(
        "nanofuzz.generators.leaderboardMinScore",
        0.9999
      );
      if (this._minScore !== baselineMinScore) {
        console.error(
          `Leaderboard repOk failed: _minScore (${this._minScore}) does not match baseline min score (${baselineMinScore}) when not full`
        );
        return false;
      }
    }

    return true;
  } // fn: repOk
} // class: Leaderboard

/**
 * Type for individual leaders and auxiliary data.
 */
export type Leader<T> = { leader: T; score: number; focus: number };
