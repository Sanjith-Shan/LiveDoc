import type { Doc } from "./doc.js";
import { key, parseKey } from "./id.js";
import { OP_DELETE, OP_UNDELETE, type CharRange, type DeleteOp, type UndeleteOp } from "./ops.js";
import type { StateVector } from "./types.js";

/**
 * One reversible step. `delId` is the delete operation currently hiding the
 * characters, or `null` when they are visible.
 *
 * Insert and delete collapse into the same shape, which is the point: undoing
 * an insert *is* hiding it, and undoing a delete *is* unhiding it. One
 * mechanism, so there is one set of concurrency semantics to reason about.
 */
interface Item {
  targets: CharRange[];
  delId: string | null;
  at: number;
}

const DEFAULT_CAPTURE_MS = 500;

/**
 * Undo and redo that behave correctly when other people are editing.
 *
 * Deletion is an OR-Set of tokens, so undoing your own delete removes only
 * *your* token. If a collaborator deleted the same characters concurrently,
 * their token remains and the text stays hidden — which is what a user expects
 * and what a naive boolean tombstone gets wrong.
 *
 * Redoing an undone insert re-deletes; redoing an undone delete re-hides. Each
 * pass mints a fresh operation rather than replaying an old one, so a redo is
 * never mistaken for a duplicate.
 *
 * Known limit: an entry cannot be undone once its operations fall below the
 * garbage-collection frontier, because the characters' text may already have
 * been reclaimed. `prune` drops those entries. The undo horizon is the GC
 * horizon — see DESIGN.md.
 */
export class UndoManager {
  private readonly undoStack: Item[] = [];
  private readonly redoStack: Item[] = [];
  /** Tokens the stacks still depend on; GC must not collect through them. */
  private readonly pinned = new Set<string>();
  private lastLocalAt = 0;

  constructor(
    private readonly doc: Doc,
    readonly captureMs: number = DEFAULT_CAPTURE_MS,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Starts a new undo entry even if the capture window has not expired. */
  stopCapturing(): void {
    this.lastLocalAt = 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pinned.clear();
  }

  noteInsert(targets: CharRange[]): void {
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top !== undefined && top.delId === null && now - this.lastLocalAt < this.captureMs) {
      top.targets.push(...targets);
      top.at = now;
    } else {
      this.undoStack.push({ targets: [...targets], delId: null, at: now });
    }
    this.lastLocalAt = now;
    this.redoStack.length = 0;
  }

  noteDelete(token: string, targets: readonly CharRange[]): void {
    const now = Date.now();
    this.undoStack.push({ targets: [...targets], delId: token, at: now });
    this.pinned.add(token);
    this.lastLocalAt = now;
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const item = this.undoStack.pop();
    if (item === undefined) return false;
    this.toggle(item);
    this.redoStack.push(item);
    this.lastLocalAt = 0;
    return true;
  }

  redo(): boolean {
    const item = this.redoStack.pop();
    if (item === undefined) return false;
    this.toggle(item);
    this.undoStack.push(item);
    this.lastLocalAt = 0;
    return true;
  }

  /** Hide if visible, unhide if hidden. Always mints a fresh operation. */
  private toggle(item: Item): void {
    if (item.delId === null) {
      const c = this.doc.mintCounter();
      const op: DeleteOp = {
        t: OP_DELETE,
        r: this.doc.replica,
        c,
        lam: this.doc.mintLamport(),
        targets: item.targets,
      };
      const token = key(op.r, op.c);
      this.doc.applyLocalOp(op);
      item.delId = token;
      this.pinned.add(token);
    } else {
      const target = item.delId;
      const parsed = parseKey(target);
      const op: UndeleteOp = {
        t: OP_UNDELETE,
        r: this.doc.replica,
        c: this.doc.mintCounter(),
        lam: this.doc.mintLamport(),
        ur: parsed.r,
        uc: parsed.c,
      };
      this.doc.applyLocalOp(op);
      this.pinned.delete(target);
      item.delId = null;
    }
  }

  /** Tokens garbage collection must keep, because a stack entry needs them. */
  pinnedTokens(): ReadonlySet<string> {
    return this.pinned;
  }

  /**
   * Drops entries whose operations are causally stable everywhere, since their
   * characters may have had their text reclaimed. Returns the number dropped.
   */
  prune(frontier: StateVector): number {
    const stale = (item: Item): boolean =>
      item.targets.some((t) => t.c + t.len <= (frontier[t.r] ?? 0)) &&
      (item.delId === null || (frontier[parseKey(item.delId).r] ?? 0) > parseKey(item.delId).c);

    let dropped = 0;
    for (const stack of [this.undoStack, this.redoStack]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const item = stack[i]!;
        // Only entries whose characters are currently visible are droppable;
        // a hidden entry still owns a token the document depends on.
        if (item.delId === null && stale(item)) {
          stack.splice(i, 1);
          dropped++;
        }
      }
    }
    return dropped;
  }
}
