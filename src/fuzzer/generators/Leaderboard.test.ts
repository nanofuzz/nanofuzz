import { Leaderboard } from "./Leaderboard";
import { InputAndSource } from "../Types";

describe("fuzzer/generator/Leaderboard:", () => {
  const nonCompliantValue = {
    tag: "ArgValueTypeWrapped" as const,
    value: 6,
  };
  const compliantValue = {
    tag: "ArgValueTypeWrapped" as const,
    value: 1,
  };
  const setupLeaderboard = () => {
    const leaderboard = new Leaderboard<InputAndSource>();
    leaderboard.postScore(
      {
        tick: 1,
        value: [nonCompliantValue],
        source: {
          type: "user",
        },
      },
      1
    );
    leaderboard.postScore(
      {
        tick: 1,
        value: [compliantValue],
        source: {
          type: "user",
        },
      },
      1
    );
    return leaderboard;
  };

  it(`filter: only leaders satisfying the predicate are visible`, () => {
    const leaderboard = setupLeaderboard();
    leaderboard.filter((leader) => leader.leader.value[0].value === 1);
    expect(leaderboard.getLeaders()).toHaveSize(1);
  });

  it(`filter: reuse outdated leaders satisfying the predicate`, () => {
    const leaderboard = setupLeaderboard();
    leaderboard.filter((leader) => leader.leader.value[0].value === 1);
    expect(leaderboard.getLeaders()).toHaveSize(1);
    leaderboard.filter((leader) => leader.leader.value[0].value !== 0);
    expect(leaderboard.getLeaders()).toHaveSize(2);
  });

  it("repOk: true for a newly created & posted-to leaderboard", () => {
    const lb = new Leaderboard<string>(5);
    expect(lb.repOk()).toBeTrue();

    lb.postScore("item1", 2.0);
    expect(lb.repOk()).toBeTrue();
  });

  it("repOk: true when leaderboard reaches capacity", () => {
    const lb = new Leaderboard<string>(3);
    lb.postScore("a", 1.0);
    lb.postScore("b", 2.0);
    lb.postScore("c", 3.0);
    expect(lb.length).toBe(3);
    expect(lb.repOk()).toBeTrue();
  });

  it("repOk: true when leaderboard exceeds capacity", () => {
    const lb = new Leaderboard<string>(3);
    lb.postScore("a", 1.0);
    lb.postScore("b", 2.0);
    lb.postScore("c", 3.0);
    lb.postScore("d", 4.0);
    expect(lb.length).toBe(3);
    expect(lb.repOk()).toBeTrue();
  });

  it("filter: repOk when reducing length < slots then post", () => {
    const lb = new Leaderboard<{ val: number }>(3);
    lb.postScore({ val: 1 }, 2.0);
    lb.postScore({ val: 2 }, 3.0);
    lb.postScore({ val: 3 }, 4.0);
    expect(lb.length).toBe(3);
    expect(lb.repOk()).toBeTrue();

    // Filter out item 1
    lb.filter((item) => item.leader.val !== 1);
    expect(lb.length).toBe(2);
    expect(lb.repOk()).toBeTrue();

    // New item should be postable because length < slots
    const posted = lb.postScore({ val: 4 }, 1.5);
    expect(posted).toBeTrue();
    expect(lb.length).toBe(3);
    expect(lb.repOk()).toBeTrue();
  });

  it("filter: handles filtering a full leaderboard, adding past capacity, then loosening filter", () => {
    const lb = new Leaderboard<{ val: number }>(2); // capacity = 2

    // 1. Fill leaderboard to capacity (items 1 & 2)
    lb.postScore({ val: 1 }, 10.0);
    lb.postScore({ val: 2 }, 20.0);
    expect(lb.length).toBe(2);
    expect(lb.repOk()).toBeTrue();

    // 2. Filter out item 1 (moves item 1 with score 10.0 to outdated_leaders)
    lb.filter((item) => item.leader.val !== 1);
    expect(lb.length).toBe(1);
    expect(lb.repOk()).toBeTrue();

    // 3. Add items past capacity: item 3 (30.0) fills slot 2, item 4 (40.0)
    // replaces item 2 (20.0)
    lb.postScore({ val: 3 }, 30.0); // length = 2 (full)
    lb.postScore({ val: 4 }, 40.0); // replaces lowest score (20.0)
    expect(lb.length).toBe(2);
    expect(lb.repOk()).toBeTrue();

    // Active leaders are now 4 (40.0) and 3 (30.0)
    // Outdated leaders contain item 1 (10.0) and item 2 (20.0)

    // 4. Loosen the filter so all items (1, 2, 3, 4) satisfy the predicate
    lb.filter(() => true);

    // Verify capacity constraint holds
    expect(lb.length).toBe(2);
    expect(lb.repOk()).toBeTrue();

    // Verify top 2 highest scoring items (40.0 and 30.0) are kept in _leaders
    const leaders = lb.getLeaders().map((l) => l.leader.val);
    expect(leaders).toContain(3);
    expect(leaders).toContain(4);
    expect(leaders).not.toContain(1);
    expect(leaders).not.toContain(2);
  });
});
