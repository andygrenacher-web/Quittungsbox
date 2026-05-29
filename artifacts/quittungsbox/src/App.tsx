import { Capacitor } from "@capacitor/core";
import { Router as WouterRouter, Route, Switch } from "wouter";
import Home          from "@/pages/Home";
import Archive       from "@/pages/Archive";
import Settings      from "@/pages/Settings";
import InstallPrompt from "@/components/InstallPrompt";

// On Android (file:// WebView) there is no base path.
// In Replit / PWA the proxy injects a base path via BASE_URL.
const rawBase    = import.meta.env.BASE_URL ?? "/";
const routerBase = Capacitor.isNativePlatform() || rawBase === "./"
  ? ""
  : rawBase.replace(/\/$/, "");

function App() {
  return (
    <WouterRouter base={routerBase}>
      <Switch>
        <Route path="/"               component={Home} />
        <Route path="/archiv"         component={Archive} />
        <Route path="/einstellungen"  component={Settings} />
        <Route path="*"               component={Home} />
      </Switch>
      {/* Hide install prompt on native — app is already installed */}
      {!Capacitor.isNativePlatform() && <InstallPrompt />}
    </WouterRouter>
  );
}

export default App;
