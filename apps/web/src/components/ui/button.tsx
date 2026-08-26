import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Button.
 *
 * One primary action per view. The signature gradient is reserved for the
 * primary variant, so a screen with two gradient buttons is a design defect.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium rounded-[var(--radius-sm)] motion-press',
    'transition-colors duration-[var(--duration-fast)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    'focus-visible:outline-[var(--color-primary-600)]',
    // Disabled must still be readable: a control the user cannot use still has
    // to be legible enough to understand why.
    'disabled:pointer-events-none disabled:opacity-55',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: [
          'text-[var(--color-text-inverse)] shadow-[var(--shadow-sm)]',
          'bg-[image:var(--gradient-signature)]',
          'hover:shadow-[var(--shadow-md)]',
          'hover:brightness-[1.04]',
        ].join(' '),
        secondary: [
          'bg-[var(--color-surface)] text-[var(--color-text-strong)]',
          'border border-[var(--color-border-strong)]',
          'hover:bg-[var(--color-surface-subtle)]',
        ].join(' '),
        ghost: [
          'text-[var(--color-text)] hover:bg-[var(--color-surface-subtle)]',
        ].join(' '),
        // Destructive intent is carried by colour and by the word in the label,
        // never by colour alone.
        danger: [
          'bg-[var(--color-danger-600)] text-[var(--color-text-inverse)]',
          'hover:bg-[var(--color-danger-700)]',
        ].join(' '),
        link: [
          'text-[var(--color-primary-700)] underline underline-offset-4',
          'hover:text-[var(--color-primary-800)]',
        ].join(' '),
      },
      size: {
        // 44px minimum height on interactive controls, per the accessibility
        // requirement, including the small variant.
        sm: 'h-11 px-3 text-[var(--text-body-sm)]',
        md: 'h-11 px-4 text-[var(--text-body)]',
        lg: 'h-12 px-6 text-[var(--text-body-lg)]',
        icon: 'h-11 w-11',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md', fullWidth: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  isLoading?: boolean;
  /**
   * Announced to assistive technology while loading. Required when `isLoading`
   * can become true, so a screen reader user is told what is happening rather
   * than hearing a button that has silently stopped responding.
   */
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      fullWidth,
      asChild = false,
      isLoading = false,
      loadingLabel = 'Working',
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Component = asChild ? Slot : 'button';

    if (asChild) {
      return (
        <Component
          ref={ref}
          className={cn(buttonVariants({ variant, size, fullWidth }), className)}
          {...props}
        >
          {children}
        </Component>
      );
    }

    return (
      <button
        ref={ref}
        // Kept focusable while loading so focus is not lost mid-action, which
        // would strand a keyboard user.
        aria-busy={isLoading || undefined}
        disabled={disabled ?? isLoading}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        {...props}
      >
        {isLoading ? (
          <>
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            <span>{loadingLabel}</span>
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';
export { buttonVariants };
