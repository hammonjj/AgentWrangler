/**
 * A transition table and the one way through it.
 *
 * Pure: no I/O, no clock of its own. Every state change in the domain goes
 * through `Machine.check`, which says why a move is illegal instead of
 * letting a record drift into a state the plan does not allow.
 */

export class IllegalTransition extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
    readonly why: string,
  ) {
    super(`${entity}: ${from} → ${to} is not allowed (${why})`);
    this.name = 'IllegalTransition';
  }
}

export interface MachineSpec<S extends string> {
  entity: string;
  /** Every state, so a table missing one is a compile-time and test-time error. */
  states: readonly S[];
  /** Where each state may go. States absent from `terminal` must appear here. */
  edges: Partial<Record<S, readonly S[]>>;
  /** No way out. */
  terminal: readonly S[];
  /** States that may go to these from anywhere non-terminal (the user's cancel, skip). */
  fromAnyActive?: readonly S[];
}

export class Machine<S extends string> {
  constructor(readonly spec: MachineSpec<S>) {}

  isTerminal(state: S): boolean {
    return this.spec.terminal.includes(state);
  }

  /** The states reachable in one step from `from`. */
  next(from: S): S[] {
    if (this.isTerminal(from)) return [];
    const out = new Set<S>(this.spec.edges[from] ?? []);
    for (const s of this.spec.fromAnyActive ?? []) out.add(s);
    return [...out];
  }

  can(from: S, to: S): boolean {
    return this.next(from).includes(to);
  }

  /** Throws `IllegalTransition` unless the table allows the move. */
  check(from: S, to: S): void {
    if (this.isTerminal(from)) throw new IllegalTransition(this.spec.entity, from, to, `${from} is terminal`);
    if (!this.can(from, to)) throw new IllegalTransition(this.spec.entity, from, to, 'no such edge');
  }
}
