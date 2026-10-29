/**
 * The failure card shown after a check fails (Task F.1b-fix).
 *
 * Extracted from the page so it can be rendered directly in a test. It was
 * inline in the page, reachable only after a real upload set component state -
 * which means asserting anything about it required a browser and a live
 * endpoint. Taking the message as a prop makes the whole presentation testable
 * offline, which is the only way it gets tested at all.
 *
 * Two failure modes are deliberately different, because they need different
 * fixes from the user:
 *
 *  - the file was refused (a format rejection) -> their file is wrong, and
 *    there is a page that tells them what a right one looks like;
 *  - the check failed after accepting the file -> their file is fine, and
 *    telling them to rebuild it would send them to rewrite a correct export
 *    for no reason. So this branch explicitly says the upload needs no change.
 *
 * And a third, which is the one that was a real bug: the *status request*
 * failed, so the app never learned how the check ended. Saying anything about
 * the file there would be a guess. It says it could not read the check, and
 * offers the retry that actually helps.
 *
 * `kind` is passed in rather than sniffed from the message so the branch cannot
 * silently change meaning when the backend rewords an error string.
 */
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

import { isUploadRejection, missingColumns, parsePlanRefusal, summariseRejection } from '@/app/check/rejection'
import { parseCanonicalRefusal, type CanonicalRefusal } from './canonical-refusal'

export type FailureKind = 'rejection' | 'run' | 'connection' | 'plan' | 'source' | 'safety'

export function CheckFailureCard({
  message,
  kind,
  refusal,
}: {
  message: string
  kind: FailureKind
  refusal?: CanonicalRefusal | null
}) {
  const source = kind === 'connection' ? null : refusal ?? parseCanonicalRefusal(message)
  const monetary = source?.code === 'cur_money_unavailable' || source?.code === 'cur_currency_unavailable'
  const missing = missingColumns(message)
  // A status-read failure is a transport problem, so the server's own message
  // is not part of it and there is no column list to show.
  const isFormatRejection = kind === 'rejection' || (kind === 'run' && isUploadRejection(message))
  // Task 6: a plan-limit refusal carries its own machine-readable body, and
  // its fix is neither the file nor a retry - it is fewer files or a bigger
  // plan, so the card says which.
  const plan = parsePlanRefusal(message)

  return (
    // `danger`, not `red-500`: the token system exists so a status has one
    // colour everywhere, and a raw palette class renders fine while sitting
    // outside it - which is exactly how a failure card ends up a different
    // red from the ErrorState that explains it.
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />
          {kind === 'connection'
            ? 'Could not read the check'
            : kind === 'safety'
              ? 'Processing safety limit reached'
            : kind === 'plan'
              ? plan?.reason === 'checks-per-day' ? 'Rolling check allowance reached' : 'Plan limit reached'
              : source ? monetary ? 'Billing cost needs review' : 'Billing observations need review' : 'Check failed'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* A plan refusal's headline is the human sentence from the body -
            not the JSON it arrived wrapped in. */}
        {source ? <p className="text-body font-medium text-foreground">{source.message}</p> : kind === 'plan' && plan ? (
          <p className="text-body font-medium text-foreground">{plan.detail}</p>
        ) : kind !== 'connection' ? (
          <p className="text-body font-medium text-foreground">{summariseRejection(message)}</p>
        ) : null}

        {missing ? (
          <div className="rounded-md border border-danger/40 bg-danger-tint p-3">
            <p className="text-caption font-medium text-danger">
              {missing.length} of 9 required columns are missing from this file:
            </p>
            <ul className="mt-2 grid gap-1 font-mono text-caption text-foreground sm:grid-cols-2">
              {missing.map((col) => (
                <li key={col} className="flex items-start gap-1">
                  <span aria-hidden="true" className="text-danger">
                    &times;
                  </span>
                  <span className="break-all">{col}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The server's own words, exactly as sent, in a block that preserves
            line breaks. Hidden only for a plan refusal (Task 6): there the
            human sentence above is the whole message, and the JSON blob
            underneath would be the paragraph of diagnostics this card
            exists to avoid. Every other failure keeps the verbatim record. */}
        {kind !== 'plan' && !source ? (
          <details className="text-body">
            <summary className="cursor-pointer text-muted-foreground">
              The server's full message
            </summary>
            <pre
              data-testid="verbatim-message"
              className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-alt p-3 font-mono text-caption leading-relaxed text-foreground"
            >
              {message}
            </pre>
          </details>
        ) : null}

        {source ? <div className="space-y-2 text-body">
          <p>{source.recovery}</p>
          <p className="text-muted-foreground">No monetary total or findings were accepted from {monetary ? 'this input' : 'these competing observations'}.</p>
          {source.invalidRows !== undefined ? <p>Amounts needing review: {source.invalidRows}</p> : null}
          {source.conflictRows !== undefined ? <p>Rows needing review: {source.conflictRows}</p> : null}
          {source.differingFields.length ? <p>{monetary ? 'Cost fields' : 'Conflicting fields'}: <span className="font-mono">{source.differingFields.join(', ')}</span></p> : null}
        </div> : kind === 'safety' ? <p className="text-body text-muted-foreground">Choose fewer or smaller exports within the processing safety limits. Upgrading does not raise this deployment’s safety limits.</p> : kind === 'plan' && plan?.reason === 'checks-per-day' ? <div className="space-y-2 text-body text-muted-foreground"><p>No check was accepted. Wait for earlier accepted checks to leave the rolling 24-hour window, or review a plan with a higher check allowance. Manual and scheduled runs share the allowance.</p><Link to="/settings/billing" className="text-accent underline">Review check usage and plan limits</Link></div> : kind === 'plan' && plan?.reason === 'file-size' ? <p className="text-body text-muted-foreground">No check was accepted. Choose a smaller export within your plan’s technical file ceiling and this deployment’s safety limits. Review the effective file limit in Billing before trying again.</p> : kind === 'plan' && plan ? (
          <p className="text-body text-muted-foreground">
            No check was accepted.{' '}
            {plan.upgrade_to
              ? `Your current plan (${plan.tier}) can be upgraded to ${plan.upgrade_to} for more. `
              : ''}
            Or remove files from this submission and try again.
          </p>
        ) : kind === 'connection' ? (
          <p className="text-body text-muted-foreground">
            The check was submitted, but the app could not read its status, so it
            cannot say whether it finished, failed, or is still running. Your
            file was uploaded and is not affected. This page keeps trying every
            few seconds; if it does not recover, reload and the check will be
            listed under the checks you have run.
          </p>
        ) : isFormatRejection ? (
          <p className="text-body text-muted-foreground">
            Every check needs an AWS Cost and Usage Report export (CUR 1.0 or CUR 2.0) with the required columns.
            CSV, compressed CSV and Parquet exports are supported. Hand-built or exported-from-a-spreadsheet CSVs do not carry
            the columns the analysis reconciles against, so they are refused
            rather than analysed on partial data.{' '}
            <Link
              to="/docs/cur-format"
              className="text-accent underline underline-offset-2 hover:text-accent-hover"
            >
              What the file must contain
            </Link>
            .
          </p>
        ) : (
          <p className="text-body text-muted-foreground">
            The check could not complete. Review the failed stage in the full
            message before deciding whether to retry, change the analysis dates,
            or replace the export.
          </p>
        )}

        {/* The three outcomes as a badge, so the difference between "your file
            was wrong" and "your file was fine" is scannable at a glance and not
            only readable in the paragraphs. The words carry the meaning; the
            badge is the summary. A plan refusal's fix is neither the file nor
            a retry, so it gets its own badge rather than borrowing one. */}
        <div>
          <Badge
            variant={
              source || kind === 'plan'
                ? 'warning'
                : isFormatRejection
                  ? 'danger'
                  : kind === 'connection'
                    ? 'warning'
                    : 'info'
            }
          >
            {source ? monetary ? 'Review cost values and rerun' : 'Select one authoritative export' : kind === 'safety' ? 'Reduce export size' : kind === 'plan'
              ? plan?.reason === 'checks-per-day' ? 'Review rolling check usage' : plan?.reason === 'file-size' ? 'Reduce export size' : 'Change the selection or upgrade'
              : isFormatRejection
                ? 'Fix the file'
                : kind === 'connection'
                  ? 'Connection problem'
                  : 'Review the failed stage'}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
