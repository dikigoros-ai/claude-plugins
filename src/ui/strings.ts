// Every string the project picker shows, in English and Greek, in one dictionary. The language
// follows the host context's locale: one starting "el" is Greek, any other English. Numbers and sizes
// are formatted with Intl in that language.

import type { PickerMatterType, PickerReason, SaveSelectionRefusal } from "../shared/picker-contract";

export type Lang = "en" | "el";

/** "el", "el-CY", "el_GR" → Greek; anything else, or nothing, → English. */
export function pickLang(locale: string | undefined): Lang {
  return typeof locale === "string" && /^el(?:$|[-_])/i.test(locale) ? "el" : "en";
}

/** Why the room binds: the plan's documents per matter, or the files one call takes. */
export interface RoomLimit {
  room: number;
  /** null when the plan's per-matter limit is not what binds (unlimited, or above the call cap). */
  perMatter: number | null;
  held: number;
  /** The linked matter's id, in linked mode. */
  matterId: number | null;
}

export interface Strings {
  /** The BCP 47 tag Intl formats with. */
  locale: string;
  waiting: string;
  loading: string;
  /** load_picker answered an error: the helper no longer has the scan (it restarted, or a newer scan pushed it out). */
  expired: string;
  /** load_picker could not be called at all, or answered something that is not a file list. */
  loadFailed: string;
  newMatter: string;
  folder(root: string): string;
  linkedHeader(id: number, title: string): string;
  title: string;
  required: string;
  type: string;
  typeNone: string;
  types: Record<PickerMatterType, string>;
  caseReference: string;
  description: string;
  truncated: Record<"depth" | "entries", string>;
  treeLabel: string;
  rootLabel: string;
  hideIneligible: string;
  reasons: Record<PickerReason, string>;
  fileTypes: Record<"pdf" | "docx" | "text", string>;
  counter(selected: number, room: number, bytes: number): string;
  suggested: string;
  clear: string;
  createAndUpload: string;
  uploadTo(id: number): string;
  saving: string;
  sent: string;
  gate: Record<"title_required" | "title_too_long" | "nothing_selected" | "over_room", (room: number) => string>;
  /** A refused tick: the limit and why it binds. */
  overRoom(limit: RoomLimit): string;
  /** A folder tick the room cut short. */
  folderLeftOut(added: number, leftOut: number, limit: RoomLimit): string;
  refusals: Record<SaveSelectionRefusal["refused"], (path: string | undefined) => string>;
  saveFailed: string;
  sendFailed: string;
  confirmMessage(c: Confirmation): string;
}

/** What the chat message after a saved selection says. */
export type Confirmation =
  | { mode: "new"; title: string; count: number; selectionId: string; digest: string }
  | { mode: "linked"; matterId: number; title: string; count: number; selectionId: string; digest: string };

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** Bytes in binary units, as the helper's own listing shows them: "812 B", "34.2 MB" ("34,2 MB" in Greek). */
export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${number} ${UNITS[unit]}`;
}

function n(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

const en: Strings = {
  locale: "en-GB",
  waiting: "Waiting for the folder scan…",
  loading: "Loading the folder’s files…",
  expired: "This list has expired; ask Claude to open the picker again.",
  loadFailed: "The list of files could not be loaded; ask Claude to open the picker again.",
  newMatter: "New matter",
  folder: (root) => `Folder: ${root}`,
  linkedHeader: (id, title) => `Adding to matter #${id} “${title}”`,
  title: "Title",
  required: "required",
  type: "Type",
  typeNone: "Not specified",
  types: {
    civil: "Civil",
    criminal: "Criminal",
    interim_application: "Interim application",
    appeal: "Appeal",
    other: "Other",
  },
  caseReference: "Case reference",
  description: "Description",
  truncated: {
    depth: "Only part of this folder was scanned: it has more levels of subfolders than the scan enters. Files further down are not listed.",
    entries: "Only part of this folder was scanned: it holds more files and folders than one scan looks at. The rest are not listed.",
  },
  treeLabel: "Files in the folder",
  rootLabel: "The whole folder",
  hideIneligible: "Hide files that cannot be uploaded",
  reasons: {
    unsupported_type: "Unsupported file type",
    too_large: "Too large (over 50 MB)",
    empty: "Empty file",
    unreadable: "Cannot be read",
    outside_directory: "Leads outside the folder",
    not_found: "No longer found",
    already_uploaded: "Already uploaded",
    other: "Cannot be uploaded",
  },
  fileTypes: { pdf: "PDF", docx: "DOCX", text: "Text" },
  counter: (selected, room, bytes) => `${n(selected, "en-GB")} / ${n(room, "en-GB")} selected · ${formatBytes(bytes, "en-GB")}`,
  suggested: "Suggested",
  clear: "Clear",
  createAndUpload: "Create matter & upload",
  uploadTo: (id) => `Upload to matter #${id}`,
  saving: "Saving the selection…",
  sent: "Sent to Claude — the upload runs in the chat.",
  gate: {
    title_required: () => "Enter a title for the matter.",
    title_too_long: () => "The title may be at most 300 characters.",
    nothing_selected: () => "Select at least one document.",
    over_room: (room) => `The selection is over the limit of ${n(room, "en-GB")} documents. Untick some.`,
  },
  overRoom: (limit) => enLimit(limit),
  folderLeftOut: (added, leftOut, limit) =>
    `${n(added, "en-GB")} added, ${n(leftOut, "en-GB")} left out. ${enLimit(limit)}`,
  refusals: {
    unknown_scan: () => "The helper no longer has this scan (it may have restarted). Ask Claude to scan the folder again.",
    not_in_scan: (path) => `${path ?? "A file"} is not in the scan. Ask Claude to scan the folder again.`,
    ineligible: (path) => `${path ?? "A file"} cannot be uploaded. Untick it and try again.`,
    duplicate_path: (path) => `${path ?? "A file"} is selected twice.`,
    over_room: () => "The selection is over the limit of documents for this matter. Untick some.",
    empty_selection: () => "Select at least one document.",
    title_required: () => "Enter a title for the matter.",
  },
  saveFailed: "The selection could not be saved. Try again.",
  sendFailed: "The selection is saved, but the message to Claude could not be sent. Try again.",
  confirmMessage: (c) => {
    const files = c.count === 1 ? "1 file" : `${c.count} files`;
    const what =
      c.mode === "new" ? `create matter “${c.title}” with ${files}` : `add ${files} to matter #${c.matterId} “${c.title}”`;
    return `Confirmed in the picker: ${what}. Run init_matter with selection_id "${c.selectionId}" and digest "${c.digest}".`;
  },
};

function enLimit({ room, perMatter, held, matterId }: RoomLimit): string {
  if (perMatter === null) return `One upload takes at most ${n(room, "en-GB")} files; the rest can follow in a second upload.`;
  if (matterId !== null && held > 0) {
    return `Matter #${matterId} holds ${n(held, "en-GB")} of the ${n(perMatter, "en-GB")} documents your plan allows per matter; ${n(room, "en-GB")} more fit.`;
  }
  return `Your plan allows ${n(perMatter, "en-GB")} documents per matter.`;
}

const el: Strings = {
  locale: "el-GR",
  waiting: "Αναμονή για τη σάρωση του φακέλου…",
  loading: "Φόρτωση των αρχείων του φακέλου…",
  expired: "Η λίστα έληξε· ζητήστε από το Claude να ανοίξει ξανά την επιλογή αρχείων.",
  loadFailed: "Δεν ήταν δυνατή η φόρτωση της λίστας αρχείων· ζητήστε από το Claude να ανοίξει ξανά την επιλογή αρχείων.",
  newMatter: "Νέα υπόθεση",
  folder: (root) => `Φάκελος: ${root}`,
  linkedHeader: (id, title) => `Προστίθενται στην υπόθεση #${id} «${title}»`,
  title: "Τίτλος",
  required: "υποχρεωτικό",
  type: "Είδος",
  typeNone: "Χωρίς προσδιορισμό",
  types: {
    civil: "Αστική",
    criminal: "Ποινική",
    interim_application: "Ενδιάμεση αίτηση",
    appeal: "Έφεση",
    other: "Άλλο",
  },
  caseReference: "Αριθμός υπόθεσης",
  description: "Περιγραφή",
  truncated: {
    depth: "Ο φάκελος σαρώθηκε εν μέρει: έχει περισσότερα επίπεδα υποφακέλων από όσα εξετάζει η σάρωση. Τα αρχεία των βαθύτερων επιπέδων δεν εμφανίζονται.",
    entries: "Ο φάκελος σαρώθηκε εν μέρει: περιέχει περισσότερα αρχεία και υποφακέλους από όσα εξετάζει μία σάρωση. Τα υπόλοιπα δεν εμφανίζονται.",
  },
  treeLabel: "Αρχεία του φακέλου",
  rootLabel: "Ολόκληρος ο φάκελος",
  hideIneligible: "Απόκρυψη αρχείων που δεν μπορούν να ανεβούν",
  reasons: {
    unsupported_type: "Μη υποστηριζόμενος τύπος αρχείου",
    too_large: "Πολύ μεγάλο (άνω των 50 MB)",
    empty: "Κενό αρχείο",
    unreadable: "Δεν είναι δυνατή η ανάγνωση",
    outside_directory: "Οδηγεί εκτός του φακέλου",
    not_found: "Δεν βρέθηκε πλέον",
    already_uploaded: "Έχει ήδη ανέβει",
    other: "Δεν μπορεί να ανέβει",
  },
  fileTypes: { pdf: "PDF", docx: "DOCX", text: "Κείμενο" },
  counter: (selected, room, bytes) =>
    `Επιλεγμένα ${n(selected, "el-GR")} / ${n(room, "el-GR")} έγγραφα · ${formatBytes(bytes, "el-GR")}`,
  suggested: "Προτεινόμενα",
  clear: "Καθαρισμός",
  createAndUpload: "Δημιουργία υπόθεσης και ανέβασμα",
  uploadTo: (id) => `Ανέβασμα στην υπόθεση #${id}`,
  saving: "Αποθήκευση της επιλογής…",
  sent: "Στάλθηκε στο Claude — το ανέβασμα συνεχίζεται στη συνομιλία.",
  gate: {
    title_required: () => "Συμπληρώστε τον τίτλο της υπόθεσης.",
    title_too_long: () => "Ο τίτλος δεν μπορεί να υπερβαίνει τους 300 χαρακτήρες.",
    nothing_selected: () => "Επιλέξτε τουλάχιστον ένα έγγραφο.",
    over_room: (room) => `Η επιλογή υπερβαίνει το όριο των ${n(room, "el-GR")} εγγράφων. Αποεπιλέξτε ορισμένα.`,
  },
  overRoom: (limit) => elLimit(limit),
  folderLeftOut: (added, leftOut, limit) =>
    `Προστέθηκαν ${n(added, "el-GR")}, παραλείφθηκαν ${n(leftOut, "el-GR")}. ${elLimit(limit)}`,
  refusals: {
    unknown_scan: () =>
      "Η σάρωση δεν είναι πλέον διαθέσιμη (ενδέχεται να έγινε επανεκκίνηση). Ζητήστε από το Claude να σαρώσει ξανά τον φάκελο.",
    not_in_scan: (path) => `Το ${path ?? "αρχείο"} δεν περιλαμβάνεται στη σάρωση. Ζητήστε από το Claude να σαρώσει ξανά τον φάκελο.`,
    ineligible: (path) => `Το ${path ?? "αρχείο"} δεν μπορεί να ανέβει. Αποεπιλέξτε το και δοκιμάστε ξανά.`,
    duplicate_path: (path) => `Το ${path ?? "αρχείο"} έχει επιλεγεί δύο φορές.`,
    over_room: () => "Η επιλογή υπερβαίνει το όριο εγγράφων της υπόθεσης. Αποεπιλέξτε ορισμένα.",
    empty_selection: () => "Επιλέξτε τουλάχιστον ένα έγγραφο.",
    title_required: () => "Συμπληρώστε τον τίτλο της υπόθεσης.",
  },
  saveFailed: "Δεν ήταν δυνατή η αποθήκευση της επιλογής. Δοκιμάστε ξανά.",
  sendFailed: "Η επιλογή αποθηκεύτηκε, αλλά το μήνυμα προς το Claude δεν στάλθηκε. Δοκιμάστε ξανά.",
  confirmMessage: (c) => {
    const what =
      c.mode === "new"
        ? `δημιουργία της υπόθεσης «${c.title}» με ${c.count === 1 ? "1 αρχείο" : `${c.count} αρχεία`}`
        : `προσθήκη ${c.count === 1 ? "1 αρχείου" : `${c.count} αρχείων`} στην υπόθεση #${c.matterId} «${c.title}»`;
    return `Επιβεβαιώθηκε στην επιλογή αρχείων: ${what}. Εκτελέστε το init_matter με selection_id "${c.selectionId}" και digest "${c.digest}".`;
  },
};

function elLimit({ room, perMatter, held, matterId }: RoomLimit): string {
  if (perMatter === null) {
    return `Κάθε ανέβασμα δέχεται έως ${n(room, "el-GR")} αρχεία· τα υπόλοιπα μπορούν να ακολουθήσουν σε δεύτερο ανέβασμα.`;
  }
  if (matterId !== null && held > 0) {
    return `Η υπόθεση #${matterId} περιέχει ήδη ${n(held, "el-GR")} από τα ${n(perMatter, "el-GR")} έγγραφα που επιτρέπει η συνδρομή σας ανά υπόθεση· χωρούν ακόμη ${n(room, "el-GR")}.`;
  }
  return `Η συνδρομή σας επιτρέπει ${n(perMatter, "el-GR")} έγγραφα ανά υπόθεση.`;
}

export const STRINGS: Record<Lang, Strings> = { en, el };

export function stringsFor(locale: string | undefined): Strings {
  return STRINGS[pickLang(locale)];
}
