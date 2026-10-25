// The difference between two texts as splices, for the note document and for
// an open editor alike.

import diff from "fast-diff";

export interface Splice {
	// Where, in the old text.
	index: number;
	remove: number;
	insert: string;
}

// Splices that turn `from` into `to`, last first: applied in that order, each
// one's index still holds, because everything before it is untouched.
export function splicesBetween(from: string, to: string): Splice[] {
	const splices: Splice[] = [];
	let current: Splice | null = null;
	let index = 0;
	for (const [op, text] of diff(from, to)) {
		if (op === diff.EQUAL) {
			index += text.length;
			current = null;
			continue;
		}
		if (!current) {
			current = { index, remove: 0, insert: "" };
			splices.push(current);
		}
		if (op === diff.DELETE) {
			current.remove += text.length;
			index += text.length;
		} else {
			current.insert += text;
		}
	}
	return splices.reverse();
}

export function applySplices(text: string, splices: Splice[]): string {
	for (const { index, remove, insert } of splices) {
		text = text.slice(0, index) + insert + text.slice(index + remove);
	}
	return text;
}
