import { ThemeReference } from './theme/ThemeReference';

// Until the real pattern/composition surfaces exist, the app renders the theme
// reference — the living record of the design system. See src/styles/index.css
// for the tokens themselves.
export function App() {
  return <ThemeReference />;
}
