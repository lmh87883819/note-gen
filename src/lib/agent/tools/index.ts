import { Tool } from '../types'
import { folderTools } from './folder-tools'
import { workspaceTools } from './workspace-tools'

export const allTools: Tool[] = [
  ...folderTools,
  ...workspaceTools,
]

export function getToolByName(name: string): Tool | undefined {
  return allTools.find(tool => tool.name === name)
}

export function getToolsByCategory(category: Tool['category']): Tool[] {
  return allTools.filter(tool => tool.category === category)
}

export function getToolDescriptions(): string {
  return allTools.map(tool => {
    const params = tool.parameters.map(p => 
      `  - ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}`
    ).join('\n')
    
    return `### ${tool.name}
${tool.description}
Category: ${tool.category}
Requires Confirmation: ${tool.requiresConfirmation ? 'Yes' : 'No'}
Parameters:
${params || '  None'}
`
  }).join('\n\n')
}

export * from './folder-tools'
export * from './workspace-tools'
