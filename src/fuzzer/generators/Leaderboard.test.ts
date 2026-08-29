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

  describe("filter", () => {
    it(`Keeps visible all and only leaders satisfying the predicate`, () => {
      const leaderboard = setupLeaderboard();
      leaderboard.filter((leader) => leader.leader.value[0].value === 1);
      expect(leaderboard.getLeaders()).toHaveSize(1);
    });
  });

  it(`Reuses outdated leaders satisfying the predicate`, () => {
    const leaderboard = setupLeaderboard();
    leaderboard.filter((leader) => leader.leader.value[0].value === 1);
    expect(leaderboard.getLeaders()).toHaveSize(1);
    leaderboard.filter((leader) => leader.leader.value[0].value !== 0);
    expect(leaderboard.getLeaders()).toHaveSize(2);
  });
});
