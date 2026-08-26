import { useEffect, useRef } from 'react';
import { ArrowLeft, Link2Off } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
import { PageHeader } from '@/features/shared/page-header';
import { useResolveLink } from '@/features/invoices/use-invoices';

/**
 * Where a link from a reminder lands.
 *
 * The token says which record was being chased and nothing else. It is exchanged
 * once, here, for a record id, and the reader is then sent to that record's own
 * page — which fetches it through the ordinary authenticated endpoint and decides
 * for itself what this person may do. A link that arrives in the wrong hands
 * therefore opens nothing: it names a destination the holder still has to be
 * entitled to reach.
 *
 * Nothing on this page distinguishes a token that never existed from one that
 * expired, was already spent, or belongs to somebody else. The server gives one
 * answer for all four, and repeating that single answer is the point: four
 * different messages would let a holder work out which tokens are real.
 */
export function SignedLinkPage() {
  const { token } = useParams<{ token: string }>();
  const resolve = useResolveLink();

  // Spent exactly once per token. Without the guard, React's development double
  // render — or any re-render before the answer arrives — would present the same
  // single-use token twice, and the second presentation is a refusal recorded
  // against a person who did nothing wrong.
  const presented = useRef<string | null>(null);
  const { mutate } = resolve;

  useEffect(() => {
    if (!token || presented.current === token) return;
    presented.current = token;
    mutate({ token });
  }, [token, mutate]);

  // Only invoices issue links today. An unknown type means a link outlived the
  // feature that made it, and is treated as a dead link rather than guessed at.
  const resolved =
    resolve.isSuccess && resolve.data.record_type === 'invoice' ? resolve.data.record_id : null;
  const dead = resolve.isError || (resolve.isSuccess && resolved === null);

  if (resolved !== null) return <Navigate to={`/invoices/${resolved}`} replace />;

  if (dead) {
    return (
      <>
        <PageHeader
          title="This link no longer works"
          purpose="Links in reminders are good for one use and expire after a few days."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/invoices">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Go to invoices
              </Link>
            </Button>
          }
        />
        <Card>
          <CardContent className="flex flex-col items-start gap-[var(--space-3)]">
            <Link2Off aria-hidden="true" className="size-6 text-[var(--color-text-subtle)]" />
            <p className="m-0 text-[var(--text-body)] text-[var(--color-text)]">
              {errorMessage(resolve.error) ?? 'The link could not be opened.'}
            </p>
            <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              Nothing has been lost. If something is still waiting on you, it is in your invoice
              list, and you can act on it there exactly as you would have here. If a newer
              reminder has arrived since this one, its link is the one that works.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Opening your link" purpose="Checking where this link points." />
      <Card>
        <CardContent>
          <SkeletonText lines={3} />
        </CardContent>
      </Card>
    </>
  );
}
