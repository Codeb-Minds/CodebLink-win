import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite only handles the React renderer.
// The Electron main process is compiled separately via: tsc -p tsconfig.electron.json
export default defineConfig({
  plugins: [react()],
  base: './',  // Required for Electron to load files from dist/ correctly
})
