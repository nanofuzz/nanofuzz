/**
 * Adapted from: https://stackoverflow.com/questions/61910721/
 *
 * This function accepts an array of PlayerRecord objects and sorts the
 * array in descending order according to the ratio of wins to losses.
 * (win / lose) such that higher ratios of wins to losses are first.
 * Some examples:
 *
 *  - {win: 3, lose: 9}  <  {win: 2, lose: 3} // 3/9  <  2/3
 *  - {win: 2, lose: 2}  >  {win: 2, lose: 3} // 2/2  >  2/3
 *  - {win: 3, lose: 9} === {win: 3, lose: 9} // 3/9 === 3/9
 *
 * In the case where a === b, both [a,b] and [b,a] are valid.
 *
 * @param array array of PlayerRecord objects
 * @returns the same array sorted by win/loss ratio
 */
export function sortByWinLoss(array: PlayerRecord[]): PlayerRecord[] {
  return array.sort((a, b) => b[WIN] / b[LOSE] - a[WIN] / a[LOSE]);
}

/**
 * A player's win-lose record.
 */
export type PlayerRecord = [number, number];
const WIN = 0;
const LOSE = 1;
