import { useTranslations } from 'next-intl';
import { RefreshCw, Trash, FileText, Layers, Hash, Target } from "lucide-react";
import useRagSettingsStore from "@/stores/ragSettings";
import { FormItem } from "../components/setting-base";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";
import { Item, ItemGroup, ItemMedia, ItemContent, ItemTitle, ItemActions, ItemDescription } from '@/components/ui/item';
import { clearVectorDb, initVectorDb } from "@/db/vector";
import { toast } from "@/hooks/use-toast";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import useVectorStore from "@/stores/vector";
import useArticleStore from "@/stores/article";
import { copyFile, exists, mkdir, readDir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";

export function Settings() {
  const t = useTranslations('settings.rag');
  
  const { 
    chunkSize, 
    chunkOverlap, 
    resultCount, 
    similarityThreshold,
    initSettings,
    updateSetting,
    resetToDefaults
  } = useRagSettingsStore();

  const { processAllDocuments, isProcessing } = useVectorStore();
  const { loadFileTree } = useArticleStore();

  useEffect(() => {
    initSettings();
  }, []);

  async function resolveKnowledgeBaseDir(): Promise<string> {
    const workspace = await (await import('@/lib/workspace')).getWorkspacePath()
    if (workspace.isCustom) {
      return await join(workspace.path, '知识库')
    }
    return await join(await appDataDir(), 'article', '知识库')
  }

  async function ensureKnowledgeBaseDir(): Promise<string> {
    const dir = await resolveKnowledgeBaseDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    return dir
  }

  function isMarkdownFile(name: string) {
    return name.toLowerCase().endsWith('.md')
  }

  async function copyMarkdownFilesRecursively(sourceDir: string, targetDir: string, relativePath: string = ''): Promise<number> {
    let copiedCount = 0
    const entries = await readDir(sourceDir)

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const sourcePath = await join(sourceDir, entry.name)
      const newRelativePath = relativePath ? await join(relativePath, entry.name) : entry.name
      const targetPath = await join(targetDir, newRelativePath)

      if (entry.isDirectory) {
        copiedCount += await copyMarkdownFilesRecursively(sourcePath, targetDir, newRelativePath)
      } else if (entry.isFile && isMarkdownFile(entry.name)) {
        const targetDirPath = relativePath ? await join(targetDir, relativePath) : targetDir
        if (!(await exists(targetDirPath))) {
          await mkdir(targetDirPath, { recursive: true })
        }
        await copyFile(sourcePath, targetPath)
        copiedCount++
      }
    }
    return copiedCount
  }

  async function handleImportFiles() {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: t('importFiles'),
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      const targetDir = await ensureKnowledgeBaseDir()

      let count = 0
      for (const p of paths) {
        const name = String(p).split(/[\\/]/).pop() || ''
        if (!name || !isMarkdownFile(name)) continue
        const targetPath = await join(targetDir, name)
        await copyFile(String(p), targetPath)
        count++
      }

      await loadFileTree()
      toast({
        title: t('importSuccess'),
        description: t('importSuccessDesc', { count }),
      })
    } catch (error) {
      toast({ title: t('importError'), description: String(error), variant: 'destructive' })
    }
  }

  async function handleImportFolder() {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: t('importFolder'),
      })
      if (!selectedPath) return
      const targetDir = await ensureKnowledgeBaseDir()
      const count = await copyMarkdownFilesRecursively(String(selectedPath), targetDir)
      await loadFileTree()
      toast({
        title: t('importSuccess'),
        description: t('importSuccessDesc', { count }),
      })
    } catch (error) {
      toast({ title: t('importError'), description: String(error), variant: 'destructive' })
    }
  }

  async function handleReindexAll() {
    await ensureKnowledgeBaseDir()
    await processAllDocuments()
  }

  function handleDeleteVector() {
    confirm(t('deleteVectorConfirm')).then(async (result) => {
      if (result) {
        await clearVectorDb()
        await initVectorDb()
        toast({
          title: t('deleteVectorSuccess'),
          variant: 'default',
        })
      }
    })
  }

  const settings = [
    {
      title: t('chunkSize'),
      desc: t('chunkSizeDesc'),
      value: chunkSize,
      min: 100,
      max: 5000,
      step: 100,
      icon: FileText,
      onChange: (value: number) => updateSetting('chunkSize', value)
    },
    {
      title: t('chunkOverlap'),
      desc: t('chunkOverlapDesc'),
      value: chunkOverlap,
      min: 0,
      max: 500,
      step: 50,
      icon: Layers,
      onChange: (value: number) => updateSetting('chunkOverlap', value)
    },
    {
      title: t('resultCount'),
      desc: t('resultCountDesc'),
      value: resultCount,
      min: 1,
      max: 10,
      step: 1,
      icon: Hash,
      onChange: (value: number) => updateSetting('resultCount', value)
    },
    {
      title: t('similarityThreshold'),
      desc: t('similarityThresholdDesc'),
      value: similarityThreshold,
      min: 0,
      max: 1,
      step: 0.01,
      icon: Target,
      onChange: (value: number) => updateSetting('similarityThreshold', value)
    }
  ]

  return (
    <>
      <FormItem title={t('settingsTitle')}>
        <ItemGroup className="gap-4">
          {settings.map((setting) => {
            const Icon = setting.icon
            return (
            <Item key={setting.title} variant="outline">
              <ItemMedia variant="icon">
                <Icon className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{setting.title}</ItemTitle>
                <ItemDescription>{setting.desc}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <div className="space-y-3 w-[180px]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{setting.min}</span>
                    <span className="text-xs font-medium">{setting.value}</span>
                    <span className="text-xs text-muted-foreground">{setting.max}</span>
                  </div>
                  <Slider
                    value={[setting.value]}
                    onValueChange={(value) => setting.onChange(value[0])}
                    min={setting.min}
                    max={setting.max}
                    step={setting.step}
                    className="w-full"
                  />
                </div>
              </ItemActions>
            </Item>
          )
          })}
        </ItemGroup>
      </FormItem>

      <FormItem title={t('libraryTitle')} desc={t('libraryDesc')}>
        <div className="flex flex-col md:flex-row gap-2">
          <Button variant="outline" onClick={handleImportFiles}>
            {t('importFiles')}
          </Button>
          <Button variant="outline" onClick={handleImportFolder}>
            {t('importFolder')}
          </Button>
          <Button variant="default" onClick={handleReindexAll} disabled={isProcessing}>
            {isProcessing ? t('reindexing') : t('reindexAll')}
          </Button>
        </div>
      </FormItem>

      <div className="flex flex-col md:flex-row gap-2 mt-4">
        <Button variant="outline" onClick={resetToDefaults}>
          <RefreshCw className="size-4 mr-2" /> {t('resetToDefaults')}
        </Button>
        <Button variant="destructive" onClick={handleDeleteVector}>
          <Trash className="size-4 mr-2" /> {t('deleteVector')}
        </Button>
      </div>
    </>
  );
}
