import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { FinoraMark } from '@/components/brand/finora-mark';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Link, useNavigate } from '@/lib/app-link';
import { authClient } from '@/lib/auth-client';

const forgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address'),
});

type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

/**
 * Asks Better Auth to email a reset link.
 *
 * The link lands on `/reset-password`, which is the same screen an invitation
 * uses to choose a password.
 */
export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const { control, handleSubmit } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const { error } = await authClient.requestPasswordReset({
        email: values.email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        toast.error(error.message ?? 'The reset link could not be sent.');
        return;
      }
      toast.success('The password reset link was sent to your email.');
      void navigate('/sign-in');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The reset link could not be sent.';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#eaf2ff] px-5 py-10">
      <div className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/85 px-8 py-10 shadow-[0_30px_60px_rgb(55_85_170_/_0.18)]">
        <FinoraMark size="md" />
        <h1 className="mt-8 text-[28px] font-bold tracking-[-0.01em] text-[#0e1a4b]">
          Forgot your password?
        </h1>
        <p className="mt-2 text-[14px] text-[#5b6a92]">
          Enter your email and we will send you a reset link.
        </p>
        <form
          onSubmit={(event) => {
            void onSubmit(event);
          }}
          noValidate
          className="mt-7 flex flex-col gap-5"
        >
          <Controller
            control={control}
            name="email"
            render={({ field, fieldState }) => (
              <Field label="Email address" required error={fieldState.error?.message}>
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    {...field}
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    type="email"
                    autoComplete="username"
                    placeholder="you@company.com"
                    className="h-12 rounded-[12px]"
                  />
                )}
              </Field>
            )}
          />
          <Button
            type="submit"
            variant="primary"
            fullWidth
            isLoading={submitting}
            loadingLabel="Sending"
          >
            Send reset link
          </Button>
          <Button variant="link" fullWidth asChild>
            <Link to="/sign-in">Back to sign in</Link>
          </Button>
        </form>
      </div>
    </div>
  );
}
