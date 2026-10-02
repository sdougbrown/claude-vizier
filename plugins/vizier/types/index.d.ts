// What the Vizier's pane shows: an appraisal (with the spec it came from, so it
// can be asked again) or the model help.
export type VizierPage = { title: string; text: string; spec?: string }

declare module 'claude-code' {
  interface PluginState {
    vizier: { page: VizierPage | null }
  }
}
