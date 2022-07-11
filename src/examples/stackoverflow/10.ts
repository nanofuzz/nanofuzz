//  Adapted from: https://stackoverflow.com/questions/48655319/

export class Game {
    private value = 0;
  
    public startGame(moves: number[]): number {
      moves.forEach(this.currentNumber);
      return this.value;
    }
  
    private currentNumber(): void {
      this.value++;
    }
  }
  