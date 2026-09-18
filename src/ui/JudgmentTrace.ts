import { NamedJudgment } from "../fuzzer/oracles/Types";

export function traceJudgment(
  j: NamedJudgment,
  depth: number = 0,
  dimmed: boolean = false // only dim once
): string {
  // Better representation of hierarchy !!!!!!!!!!
  return `<pre${depth === 0 ? ` class="outer"` : ``}>${j.name}: ${j.judgment}${j.error ? ` (error ${j.error.name}: ${j.error.message})` : ``}${j.trace
    .flat(1)
    .map((sj) =>
      dimmed || j.deciders.some((dj) => dj.name === sj.name)
        ? `${traceJudgment(sj, depth + 1, dimmed)}`
        : `<span class="faded">${traceJudgment(sj, depth + 1, true)}</span>`
    )
    .join("")}</pre>`;
}
