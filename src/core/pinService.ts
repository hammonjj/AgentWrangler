/** User-defined conversation sections (historical class name retained for wiring compatibility). */
import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';

export const GENERAL_SECTION = 'General';
const SECTIONS_KEY = 'agentWrangler.conversationSections';
const ASSIGNMENTS_KEY = 'agentWrangler.conversationSectionAssignments';

interface SectionAssignment { key: string; section: string; atMs: number }

export class PinService {
  private emitter = new Emitter<void>();
  private sections: string[];
  private assignments: SectionAssignment[];

  constructor(private storage: KeyValueStorage) {
    this.sections = this.readSections();
    this.assignments = this.readAssignments();
  }

  private readSections(): string[] {
    const raw = this.storage.get<unknown>(SECTIONS_KEY, []);
    const sections = [GENERAL_SECTION];
    if (!Array.isArray(raw)) return sections;
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      const name = value.trim();
      if (!name || sections.some((section) => section.toLocaleLowerCase() === name.toLocaleLowerCase())) continue;
      sections.push(name);
    }
    return sections;
  }

  private readAssignments(): SectionAssignment[] {
    const raw = this.storage.get<unknown>(ASSIGNMENTS_KEY, []);
    return Array.isArray(raw) ? raw.filter(isAssignment) : [];
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get names(): string[] {
    this.sections = this.readSections();
    return [...this.sections];
  }
  sectionFor(key: string): string {
    this.assignments = this.readAssignments();
    return this.assignments.find((item) => item.key === key)?.section ?? GENERAL_SECTION;
  }
  assignedAt(key: string): number | undefined {
    this.assignments = this.readAssignments();
    return this.assignments.find((item) => item.key === key)?.atMs;
  }

  create(name: string): boolean {
    const clean = name.trim();
    const current = this.names;
    if (!clean || current.some((section) => section.toLocaleLowerCase() === clean.toLocaleLowerCase())) return false;
    this.sections = [...current, clean];
    void this.storage.update(SECTIONS_KEY, this.sections.filter((section) => section !== GENERAL_SECTION));
    this.emitter.fire();
    return true;
  }

  assign(key: string, section: string): void {
    const canonical = this.names.find((name) => name.toLocaleLowerCase() === section.toLocaleLowerCase());
    const current = this.readAssignments();
    const currentSection = current.find((item) => item.key === key)?.section ?? GENERAL_SECTION;
    if (!canonical || currentSection === canonical) return;
    const merged = new Map(current.map((item) => [item.key, item]));
    if (canonical === GENERAL_SECTION) merged.delete(key);
    else merged.set(key, { key, section: canonical, atMs: Date.now() });
    this.assignments = [...merged.values()];
    void this.storage.update(ASSIGNMENTS_KEY, this.assignments);
    this.emitter.fire();
  }

}

function isAssignment(value: unknown): value is SectionAssignment {
  const item = value as SectionAssignment | undefined;
  return typeof item?.key === 'string' && typeof item.section === 'string'
    && item.section.trim().length > 0 && typeof item.atMs === 'number';
}
