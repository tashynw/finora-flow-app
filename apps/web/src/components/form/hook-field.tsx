import { Controller, type Control, type ControllerRenderProps, type FieldPath, type FieldValues } from 'react-hook-form';

import { Field } from '@/components/ui/field';

/**
 * A labelled field bound to react-hook-form.
 *
 * The Zod resolver decides when the field is wrong. This only places that
 * message under the input and marks the control invalid.
 */
export function HookField<T extends FieldValues, TName extends FieldPath<T>>({
  control,
  name,
  label,
  help,
  required,
  formatHint,
  children,
}: {
  control: Control<T>;
  name: TName;
  label: string;
  help?: string | undefined;
  required?: boolean | undefined;
  formatHint?: string | undefined;
  children: (
    ids: {
      inputId: string;
      describedBy: string | undefined;
      invalid: boolean;
    },
    field: ControllerRenderProps<T, TName>,
  ) => React.ReactNode;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          help={help}
          required={required}
          formatHint={formatHint}
          error={fieldState.error?.message}
        >
          {(ids) => children(ids, field)}
        </Field>
      )}
    />
  );
}
