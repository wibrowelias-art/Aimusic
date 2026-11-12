import '@fontsource-variable/inter';
import './ui/styles.css';
import { mountShell } from './ui/shell';

const root = document.querySelector<HTMLElement>('#app');
if (root) mountShell(root);
