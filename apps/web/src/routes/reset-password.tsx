import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute } from '@tanstack/react-router';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { FinoraMark } from '@/components/brand/finora-mark';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useNavigate } from '@/lib/app-link';
import { authClient } from '@/lib/auth-client';

const resetPasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
    confirmNewPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmNewPassword, {
    message: 'Passwords do not match.',
    path: ['confirmNewPassword'],
  });

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
    error: typeof search.error === 'string' ? search.error : '',
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token, error } = Route.useSearch();
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { control, handleSubmit } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '', confirmNewPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!token) {
      toast.error('This invitation link is missing its token.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await authClient.resetPassword({
        newPassword: values.newPassword,
        token,
      });
      if (result.error) {
        toast.error(result.error.message ?? 'The password could not be saved.');
        return;
      }
      toast.success('Password has been reset successfully!');
      navigate('/sign-in');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#eaf2ff] px-5 py-10">
      <div className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/85 px-8 py-10 shadow-[0_30px_60px_rgb(55_85_170_/_0.18)]">
        <FinoraMark size="md" />
        <h1 className="mt-8 text-[28px] font-bold tracking-[-0.01em] text-[#0e1a4b]">
          Choose a password
        </h1>
        <p className="mt-2 text-[14px] text-[#5b6a92]">
          This finishes your invitation. Afterward, sign in with this password.
        </p>
        {error ? (
          <p role="alert" className="mt-4 text-[14px] text-[var(--color-danger-700)]">
            This invitation link is no longer valid. Ask an administrator to send it again.
          </p>
        ) : null}
        <form onSubmit={onSubmit} noValidate className="mt-7 flex flex-col gap-5">
          <PasswordField
            control={control}
            name="newPassword"
            label="New password"
            shown={showNewPassword}
            onToggle={() => setShowNewPassword((current) => !current)}
            autoComplete="new-password"
          />
          <PasswordField
            control={control}
            name="confirmNewPassword"
            label="Confirm new password"
            shown={showConfirmPassword}
            onToggle={() => setShowConfirmPassword((current) => !current)}
            autoComplete="new-password"
          />
          <Button
            type="submit"
            variant="primary"
            fullWidth
            isLoading={submitting}
            loadingLabel="Saving"
            disabled={!token || Boolean(error)}
          >
            Save password
          </Button>
        </form>
      </div>
    </div>
  );
}

function PasswordField({
  control,
  name,
  label,
  shown,
  onToggle,
  autoComplete,
}: {
  control: ReturnType<typeof useForm<ResetPasswordValues>>['control'];
  name: keyof ResetPasswordValues;
  label: string;
  shown: boolean;
  onToggle: () => void;
  autoComplete: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field label={label} required error={fieldState.error?.message}>
          {({ inputId, describedBy, invalid }) => (
            <span className="relative block">
              <Input
                {...field}
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                type={shown ? 'text' : 'password'}
                autoComplete={autoComplete}
                className="h-12 rounded-[12px] pr-11"
              />
              <button
                type="button"
                onClick={onToggle}
                aria-label={shown ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5b6a92]"
              >
                {shown ? (
                  <EyeOff aria-hidden="true" className="size-5" />
                ) : (
                  <Eye aria-hidden="true" className="size-5" />
                )}
              </button>
            </span>
          )}
        </Field>
      )}
    />
  );
}
