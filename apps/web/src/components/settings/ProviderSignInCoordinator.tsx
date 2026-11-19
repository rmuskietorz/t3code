import { useAtomValue } from "@effect/atom-react";
import { AuthTerminalOperateScope, type ServerProvider } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { resolveOnboardingProviderLoginCommand } from "../../onboarding/providerReadiness.logic";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { environmentPresentations } from "../../state/presentation";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { CommandBlock } from "../CommandBlock";
import { AgentInstallTerminal, isInstallableDriver } from "../onboarding/WelcomePage";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function needsSignIn(provider: ServerProvider): boolean {
  return (
    isInstallableDriver(provider.driver) &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.auth.status === "unauthenticated"
  );
}

/**
 * Asks to sign in again whenever a provider on a connected environment is signed out, which
 * includes the state found at app start. "Later" holds until that provider is signed in again,
 * so a later sign-out asks again.
 */
const signedOutProvidersAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].flatMap(([environmentId, presentation]) => {
    const serverConfig = presentation.serverConfig;
    if (presentation.connection.phase !== "connected" || !serverConfig) return [];
    return get(providersIgnoringCheckedAtAtom(environmentId))
      .filter(needsSignIn)
      .flatMap((provider) => {
        const driver = provider.driver;
        // Only CLIs that sign in from a terminal; the others keep their own setup flow.
        if (!isInstallableDriver(driver)) return [];
        return [
          {
            key: JSON.stringify([environmentId, provider.instanceId]),
            environmentId,
            environmentLabel: presentation.entry.target.label,
            provider,
            serverConfig,
            driver,
          },
        ];
      });
  }),
).pipe(Atom.withLabel("web-provider-sign-in-signed-out"));

export function ProviderSignInCoordinator() {
  const signedOut = useAtomValue(signedOutProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const signedOutKeys = signedOut.map((entry) => entry.key).join("\n");
  const [dismissal, setDismissal] = useState(() => ({
    forKeys: signedOutKeys,
    keys: new Set<string>(),
  }));
  if (dismissal.forKeys !== signedOutKeys) {
    setDismissal({
      forKeys: signedOutKeys,
      keys: new Set([...dismissal.keys].filter((key) => signedOutKeys.split("\n").includes(key))),
    });
  }
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const next = signedOut.find((entry) => !dismissal.keys.has(entry.key));
  const canOperateTerminal = useEnvironmentScope(
    next?.environmentId ?? null,
    AuthTerminalOperateScope,
  );

  const dismiss = () => {
    if (!next) return;
    setSigningIn(null);
    setDismissal((current) => ({ ...current, keys: new Set(current.keys).add(next.key) }));
  };
  if (!next) return null;

  const providerName =
    next.provider.displayName?.trim() || formatProviderDriverKindLabel(next.provider.driver);
  const command = resolveOnboardingProviderLoginCommand(
    next.provider,
    next.serverConfig.settings,
    next.serverConfig.environment.platform.os,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{providerName} is signed out</DialogTitle>
          <DialogDescription>
            Sign in again on {next.environmentLabel} to keep running {providerName} threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!canOperateTerminal ? (
            <CommandBlock command={command} />
          ) : signingIn === next.key ? (
            <AgentInstallTerminal
              key={next.key}
              session={{
                environmentId: next.environmentId,
                driver: next.driver,
                providerInstanceId: next.provider.instanceId,
                cwd: next.serverConfig.cwd,
                command,
                keybindings: next.serverConfig.keybindings,
              }}
              onCommandFinished={() => {
                // A finished login is the moment to re-check; a success closes this dialog.
                void refreshProviders({
                  environmentId: next.environmentId,
                  input: { instanceId: next.provider.instanceId, fresh: true },
                });
              }}
              onClose={() => {
                setSigningIn(null);
                void refreshProviders({
                  environmentId: next.environmentId,
                  input: { instanceId: next.provider.instanceId, fresh: true },
                });
              }}
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>
            Later
          </Button>
          {canOperateTerminal && signingIn !== next.key ? (
            <Button onClick={() => setSigningIn(next.key)}>Sign in</Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
