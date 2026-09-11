export abstract class AbstractTestAdapter {
  public abstract toString(): string;

  public abstract get filename(): string;

  public abstract get toolname(): string;
}
