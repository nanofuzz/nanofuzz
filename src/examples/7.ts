/**
 * Adapted from: https://stackoverflow.com/questions/61910721/
 *
 * This function accepts an array of PlayerRecord objects and sorts the
 * array in descending order according to the ratio of wins to losses.
 * (win / lose) such that higher ratios are sorted first. Examples:
 *
 *  - {win: 3, lose: 9}  <  {win: 2, lose: 3} // 3/9  <  2/3
 *  - {win: 2, lose: 2}  >  {win: 2, lose: 3} // 2/2  >  2/3
 *  - {win: 3, lose: 9} === {win: 3, lose: 9} // 3/9 === 3/9
 *
 * In the case where a === b, both [a,b] and [b,a] are valid.
 *
 * Note: A previous routine (not included here) ensures:
 *  - `win`  is always an integer >= 0 and never NaN.
 *  - `lose` is always an integer >= 1 and never NaN (meaning,
 *    there is no opportunity for a divide by zero here)
 *
 * @param array array of PlayerRecord objects
 * @returns the same array sorted by win/loss ratio
 */
export function sortByWinLoss(array: PlayerRecord[]): PlayerRecord[] {
  // (a,b) => {} must return: -1: a < b, 0: a === b, 1: a > b
  return array.sort((a, b) => a.win / a.lose || b.win / b.lose);
}

/**
 * A player's win-lose record.
 */
export type PlayerRecord = {
  playerName: string;
  win: number; // integer of wins: always >= 0 and never NaN
  lose: number; // integer of losses: always >= 1 and never NaN
};
