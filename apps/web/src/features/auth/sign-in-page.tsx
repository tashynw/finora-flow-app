import { useState } from 'react';
import { ShieldCheck, Sparkles } from 'lucide-react';

import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { FinoraMark } from '@/components/brand/finora-mark';
import { AuroraBackground } from '@/components/ui/aurora-background';
import { Reveal } from '@/components/ui/reveal';
import { ShinyText } from '@/components/ui/shiny-text';
import { useAuth } from '@/features/auth/auth-context';

const HERO_POINTS = [
  'Every approval and payment is fully auditable',
  'Suggestions are always reviewable, and never decide on your behalf',
  'Works end to end with automation switched off',
];

/**
 * Sign-in.
 *
 * Which methods appear is decided by the API, not hard-coded here, so a
 * deployment with single sign-on configured shows only that.
 */
export function SignInPage() {
  const { signIn, methods } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim());
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Sign-in could not be completed. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Launch visual. One of the few places glass and full gradient are used. */}
      <div
        className="relative isolate hidden flex-col justify-between overflow-hidden p-[var(--space-12)] lg:flex"
        style={{ backgroundImage: 'var(--gradient-signature)' }}
      >
        <AuroraBackground />

        <Reveal className="relative z-10">
          <FinoraMark showWordmark variant="inverse" />
        </Reveal>

        <div className="relative z-10 max-w-lg text-[var(--color-text-inverse)]">
          <Reveal delay={0.05}>
            <span className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-white/25 bg-white/10 px-3 py-1 text-[length:var(--text-overline)] font-semibold uppercase tracking-wider backdrop-blur-sm">
              <Sparkles aria-hidden="true" className="size-3.5" />
              <ShinyText>AI-powered automation</ShinyText>
            </span>
          </Reveal>

          <h1 className="mt-[var(--space-5)] text-[length:var(--text-display-lg)] leading-[var(--text-display-lg--line-height)] font-bold text-[var(--color-text-inverse)]">
            <Reveal as="span" delay={0.12} className="block">
              One view from
            </Reveal>
            <Reveal as="span" delay={0.2} className="block">
              estimate to payment
            </Reveal>
          </h1>

          <Reveal delay={0.3}>
            <p className="mt-[var(--space-4)] text-[var(--text-body-lg)] opacity-95">
              Invoices and estimates arrive by email, are checked, approved and
              paid in one place, with a complete record of who decided what and
              when.
            </p>
          </Reveal>

          <ul className="mt-[var(--space-8)] m-0 flex list-none flex-col gap-[var(--space-3)] p-0 text-[var(--text-body)] opacity-95">
            {HERO_POINTS.map((line, index) => (
              <Reveal
                key={line}
                as="li"
                delay={0.42 + index * 0.1}
                className="flex items-start gap-2.5"
              >
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 size-[18px] shrink-0"
                />
                {line}
              </Reveal>
            ))}
          </ul>
        </div>

        <p className="relative z-10 m-0 text-[var(--text-caption)] text-[var(--color-text-inverse)] opacity-80">
          Internal system. Authorized users only.
        </p>
      </div>

      <div className="flex items-center justify-center px-[var(--space-6)] py-[var(--space-12)]">
        <Reveal className="w-full max-w-sm" delay={0.15}>
          <div className="lg:hidden">
            <FinoraMark showWordmark />
          </div>

          <h2 className="mt-[var(--space-6)] text-[length:var(--text-heading-1)] leading-[var(--text-heading-1--line-height)] font-bold lg:mt-0">
            Sign in
          </h2>
          <p className="mt-[var(--space-2)] text-[var(--text-body)] text-[var(--color-text-muted)]">
            Use your work account to continue.
          </p>

          {methods?.oidc_enabled && methods.oidc_authorize_url ? (
            <Button
              variant="primary"
              size="lg"
              fullWidth
              className="mt-[var(--space-6)]"
              asChild
            >
              <a href={methods.oidc_authorize_url}>Continue with single sign-on</a>
            </Button>
          ) : null}

          {methods?.oidc_enabled && methods.local_accounts_enabled ? (
            <div className="my-[var(--space-6)] flex items-center gap-3">
              <span className="h-px flex-1 bg-[var(--color-divider)]" />
              <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                or
              </span>
              <span className="h-px flex-1 bg-[var(--color-divider)]" />
            </div>
          ) : null}

          {methods?.local_accounts_enabled ? (
            <form
              onSubmit={handleSubmit}
              noValidate
              className="mt-[var(--space-6)] flex flex-col gap-[var(--space-4)]"
            >
              <Field
                label="Work email address"
                required
                help="Development sign-in. Single sign-on is used in production."
                error={error ?? undefined}
              >
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                )}
              </Field>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={submitting}
                loadingLabel="Signing in"
              >
                Sign in
              </Button>
            </form>
          ) : null}

          {!methods ? (
            <p className="mt-[var(--space-6)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              Checking available sign-in methods.
            </p>
          ) : null}

          {methods && !methods.oidc_enabled && !methods.local_accounts_enabled ? (
            <div className="mt-[var(--space-6)] rounded-[var(--radius-md)] border border-[var(--color-warning-600)] bg-[var(--color-warning-50)] p-[var(--space-4)]">
              <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-warning-700)]">
                No sign-in method is configured for this deployment. An
                administrator needs to register an identity provider before
                anyone can sign in.
              </p>
            </div>
          ) : null}
        </Reveal>
      </div>
    </div>
  );
}
