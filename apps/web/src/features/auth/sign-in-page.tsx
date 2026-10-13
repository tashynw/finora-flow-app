import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useReducedMotion } from "motion/react";
import {
  ArrowRight,
  BarChart3,
  Eye,
  EyeOff,
  KeyRound,
  ListChecks,
  Lock,
  Mail,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { FinoraMark } from "@/components/brand/finora-mark";
import { useAuth } from "@/features/auth/auth-context";
import { WorkflowSpiral, WorkflowStrip } from "@/features/auth/workflow-flow";
import scene from "@/assets/scene/signin-scene.jpg";
import flowVideo from "@/assets/scene/signin-flow.mp4";

const signInSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type SignInValues = z.infer<typeof signInSchema>;

const FEATURES: { icon: LucideIcon; title: string; desc: string }[] = [
  {
    icon: BarChart3,
    title: "Real-time visibility",
    desc: "Track spend, approvals and payments across all units in one place.",
  },
  {
    icon: ShieldCheck,
    title: "Enterprise controls",
    desc: "Role-based access, approval workflows and policy enforcement.",
  },
  {
    icon: ListChecks,
    title: "Complete audit trail",
    desc: "Every action tracked and traceable for greater accountability.",
  },
];

const TRUST: { icon: LucideIcon; title: string; desc: string }[] = [
  {
    icon: Lock,
    title: "Secure & compliant",
    desc: "Every decision is audited",
  },
  {
    icon: ShieldCheck,
    title: "Your data stays yours",
    desc: "AI runs on your own gateway",
  },
  {
    icon: KeyRound,
    title: "Built for control",
    desc: "Segregation of duties enforced",
  },
];

/**
 * Sign-in.
 *
 * The full-bleed glass-spiral scene, a marketing column, the workflow flowing
 * through its four stages, and a frosted sign-in panel. Email and password go
 * to the Nest server through Better Auth.
 */
export function SignInPage() {
  const { signIn } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const reduceMotion = useReducedMotion();
  const { control, handleSubmit } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setSubmitting(true);
    try {
      await signIn(values.email.trim(), values.password);
      toast.success("Signed in");
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Sign-in could not be completed. Check your connection and try again.";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-[#eaf2ff]">
      {/* The spiral scene, gently flowing. The still frame shows until the
          loop is ready, and stays when motion is reduced. */}
      {reduceMotion ? (
        <img
          src={scene}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none object-cover object-[46%_center]"
        />
      ) : (
        <video
          aria-hidden="true"
          src={flowVideo}
          poster={scene}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none object-cover object-[46%_center]"
        />
      )}
      {/* Lifts the left of the scene so the headline reads without a box. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgb(247_250_255_/_0.92)_0%,rgb(245_249_255_/_0.55)_38%,rgb(245_249_255_/_0.25)_100%)] lg:right-auto lg:w-[62%] lg:bg-[linear-gradient(90deg,rgb(247_250_255_/_0.94)_0%,rgb(245_249_255_/_0.82)_42%,rgb(245_249_255_/_0)_100%)]"
      />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1600px] flex-col gap-8 px-5 py-8 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:gap-10 lg:px-[5%] xl:grid xl:grid-cols-[minmax(360px,440px)_minmax(0,1fr)_400px] xl:gap-8">
        {/* Phone header: the brand, the promise and the flow, above the form. */}
        <header className="relative z-10 flex flex-col gap-5 lg:hidden">
          <FinoraMark size="md" />
          <h1 className="m-0 text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e1a4b]">
            From estimate to payment,{" "}
            <span className="bg-[linear-gradient(90deg,#3569f4_0%,#6d4cf0_100%)] bg-clip-text text-transparent">
              in flow.
            </span>
          </h1>
          <WorkflowStrip />
        </header>

        {/* Marketing column */}
        <aside className="relative z-10 hidden w-[400px] shrink-0 flex-col lg:flex xl:w-auto">
          <FinoraMark size="lg" className="mb-12" />

          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#4a5a86]">
            Finance operations, simplified
          </p>
          <h1 className="mt-3 text-[40px] font-bold leading-[1.08] tracking-[-0.02em] text-[#0e1a4b] xl:text-[46px] 2xl:text-[48px]">
            From estimate
            <br />
            to payment,{" "}
            <span className="bg-[linear-gradient(90deg,#3569f4_0%,#6d4cf0_100%)] bg-clip-text text-transparent">
              in flow.
            </span>
          </h1>
          <p className="mt-4 m-0 max-w-[400px] text-[16px] leading-relaxed text-[#4a5a86]">
            Streamline your finance operations with complete visibility,
            stronger controls, and faster workflows across your business.
          </p>

          {/* Laptop widths have no room for the spiral, so the flow runs here. */}
          <WorkflowStrip className="mt-7 xl:hidden" />

          <ul className="mt-9 m-0 flex list-none flex-col gap-7 p-0">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="flex items-start gap-4">
                <span
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-[14px] border border-white/80 bg-white/75 text-[#2f6bf2] shadow-[0_6px_16px_rgb(53_105_244_/_0.12)] backdrop-blur-sm"
                >
                  <feature.icon className="size-5" strokeWidth={2.4} />
                </span>
                <span className="min-w-0 pt-0.5">
                  <span className="block text-[15px] font-semibold text-[#0e1a4b]">
                    {feature.title}
                  </span>
                  <span className="mt-1 block max-w-[300px] text-[13px] leading-snug text-[#5b6a92]">
                    {feature.desc}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </aside>

        {/* The workflow flowing along the spiral in the scene. */}
        <div className="relative z-0 hidden items-center justify-center self-stretch xl:flex">
          <WorkflowSpiral />
        </div>
        {/* Sign-in panel */}
        <main className="relative z-10 mx-auto w-full max-w-[400px] lg:mx-0 lg:shrink-0 xl:justify-self-end">
          <div className="relative rounded-[28px] border border-white/80 bg-[linear-gradient(160deg,rgb(255_255_255_/_0.82),rgb(242_246_255_/_0.66))] px-6 pb-6 pt-8 shadow-[0_30px_60px sm:px-10 sm:pt-10_rgb(55_85_170_/_0.22),inset_0_1px_0_rgb(255_255_255_/_0.95)] backdrop-blur-xl">
            <FinoraMark size="md" className="hidden lg:flex" />

            <h2 className="text-[28px] font-bold lg:mt-10 lg:text-[32px] leading-tight tracking-[-0.01em] text-[#0e1a4b]">
              Welcome back
            </h2>
            <p className="mt-2 m-0 text-[14px] leading-relaxed text-[#5b6a92]">
              Sign in to access your finance operations and keep your business
              in flow.
            </p>

            <div className="mt-7">
              <form
                onSubmit={(event) => {
                  void onSubmit(event);
                }}
                noValidate
                className="flex flex-col gap-5"
              >
                <Controller
                  control={control}
                  name="email"
                  render={({ field, fieldState }) => (
                    <Field
                      label="Work email"
                      required
                      error={fieldState.error?.message}
                    >
                      {({ inputId, describedBy, invalid }) => (
                        <span className="relative block">
                          <Mail
                            aria-hidden="true"
                            className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-[#5b6a92]"
                          />
                          <Input
                            {...field}
                            id={inputId}
                            aria-describedby={describedBy}
                            invalid={invalid}
                            type="email"
                            autoComplete="username"
                            placeholder="you@company.com"
                            className="h-12 rounded-[12px] border-[#c9d6f5] bg-white/85 pl-11 text-[14px] shadow-[inset_0_1px_2px_rgb(30_60_140_/_0.05)]"
                          />
                        </span>
                      )}
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="password"
                  render={({ field, fieldState }) => (
                    <Field
                      label="Password"
                      required
                      error={
                        fieldState.error?.message ?? formError ?? undefined
                      }
                    >
                      {({ inputId, describedBy, invalid }) => (
                        <span className="relative block">
                          <Lock
                            aria-hidden="true"
                            className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-[#5b6a92]"
                          />
                          <Input
                            {...field}
                            id={inputId}
                            aria-describedby={describedBy}
                            invalid={invalid}
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            placeholder="Enter your password"
                            className="h-12 rounded-[12px] border-[#c9d6f5] bg-white/85 pl-11 pr-11 text-[14px] shadow-[inset_0_1px_2px_rgb(30_60_140_/_0.05)]"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowPassword((current) => !current)
                            }
                            aria-label={
                              showPassword ? "Hide password" : "Show password"
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5b6a92]"
                          >
                            {showPassword ? (
                              <EyeOff
                                aria-hidden="true"
                                className="size-5 cursor-pointer"
                              />
                            ) : (
                              <Eye
                                aria-hidden="true"
                                className="size-5 cursor-pointer"
                              />
                            )}
                          </button>
                        </span>
                      )}
                    </Field>
                  )}
                />

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  isLoading={submitting}
                  loadingLabel="Signing in"
                  className="h-12 rounded-[12px] bg-[linear-gradient(90deg,#2f6bf2_0%,#3a5ff0_55%,#5b4bf0_100%)] text-[15px] shadow-[0_10px_22px_rgb(53_90_240_/_0.32)] hover:brightness-[1.06] cursor-pointer"
                >
                  Sign in
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
              </form>
            </div>

            <ul className="mt-8 m-0 grid list-none grid-cols-3 divide-x divide-[#dbe3f5] p-0">
              {TRUST.map((item) => (
                <li key={item.title} className="px-3 first:pl-0 last:pr-0">
                  <span
                    aria-hidden="true"
                    className="flex size-8 items-center justify-center rounded-full bg-[#e6eeff] text-[#2f6bf2]"
                  >
                    <item.icon className="size-4" strokeWidth={2.4} />
                  </span>
                  <span className="mt-2.5 block text-[11px] font-semibold leading-tight text-[#0e1a4b]">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-[10px] leading-snug text-[#6b7898]">
                    {item.desc}
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-7 m-0 text-center text-[10px] text-[#7381a2]">
              Internal system&nbsp;&nbsp;|&nbsp;&nbsp;Authorized users only
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
