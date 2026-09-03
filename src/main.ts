import './styles.css';
import { AnimationEditor } from './app/AnimationEditor.ts';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing #app mount point.');

new AnimationEditor(root);
