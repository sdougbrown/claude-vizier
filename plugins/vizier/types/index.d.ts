// One courtier's words in the pane: his mark, his name and model, his text.
export type VizierSpeech = { mark: string; speaker: string; text: string }

// What the Vizier's pane shows: the speeches so far, who is still deliberating,
// and the specs that produced them, so `again` can ask the same court.
export type VizierPage = { title: string; speeches: VizierSpeech[]; awaiting?: string; specs?: string[] }

declare module 'claude-code' {
  interface PluginState {
    vizier: { page: VizierPage | null }
  }
}
