import { Offline, SignInError, SignedOut } from "./auth.ts";
import { Unauthorized } from "./relay.ts";

// An error as the member reads it.
export function describe(error: unknown): string {
	if (error instanceof SignInError || error instanceof SignedOut || error instanceof Offline) return error.message;
	if (error instanceof Unauthorized) return `${error.message} Sign out and sign in again.`;
	if (error instanceof Error) return error.message;
	return String(error);
}
