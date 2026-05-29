import { Router as WouterRouter, Route, Switch } from "wouter";
import Home from "@/pages/Home";

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="*" component={Home} />
      </Switch>
    </WouterRouter>
  );
}

export default App;
