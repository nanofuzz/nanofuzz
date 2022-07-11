import { Game } from "./10";

const game = new Game();

describe("10", () => {
  test("10", () => {
    expect(game.startGame([])).toStrictEqual(0);
  });
});
