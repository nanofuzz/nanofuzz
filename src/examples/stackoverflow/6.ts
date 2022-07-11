/**
 * Adapted from: https://stackoverflow.com/questions/65428615/
 * 
 * This function accepts an array of MyId objects and returns the name
 * of the first object with myId === 0.
 * 
 * @param inArray array of MyId objects
 * @returns the name of the first object with myId === 0
 */
export function getZeroMyId(inArray: MyId[]): string {
    return inArray.filter(q => q.myId === 0)[0].name;
}

/**
 * A MyId object, which is comprised of a name and a myId.
 */
export type MyId = {
    myId: number;
    name: string;
}