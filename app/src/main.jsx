import { render } from 'preact';
import './styles.css';
import { App } from './App.jsx';
import { connect } from './state.js';

render(<App />, document.getElementById('app'));
connect();

// Offline shell for the phone (home-screen app). Skipped on the Mac hub so a rebuild
// shows up on the next reload.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
