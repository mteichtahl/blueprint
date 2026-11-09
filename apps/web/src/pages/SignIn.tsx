import { AuthFrame } from '../components/Shell.tsx';
import { Button, Card } from '../components/ui.tsx';

export function SignIn({ onSignIn, signedOut }: { onSignIn: () => void; signedOut: boolean }) {
  return (
    <AuthFrame
      eyebrow={signedOut ? 'Signed out' : 'Sign in'}
      title={signedOut ? 'See you soon' : 'Welcome to Blueprint'}
      sub="Your artist development workspace."
    >
      <Card>
        <h2 className="t m-0 text-[22px]">Sign in</h2>
        <p className="m-0 text-[15px] text-muted-foreground">
          Use a passkey (fastest), or your email and password. Two-step verification is required for
          everyone.
        </p>
        <Button variant="cta" className="min-h-[50px] w-full" onClick={onSignIn}>
          Sign in
        </Button>
        <span className="src">Accounts are by invitation from Blueprint.</span>
      </Card>
    </AuthFrame>
  );
}
