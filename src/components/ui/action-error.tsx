import type { ActionFailure } from "./action-failure";

/**
 * Error for a failed action, with a sign-in link when the session expired. `className` replaces the
 * default small red text (e.g. to render it as a banner).
 */
export function ActionError({ error, className = "text-xs text-danger" }: { error: ActionFailure | null; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={className}>
      {error.message}
      {error.signInHref ? (
        <>
          {" "}
          <a href={error.signInHref} className="font-semibold underline underline-offset-2">
            Sign in
          </a>
        </>
      ) : null}
    </p>
  );
}
