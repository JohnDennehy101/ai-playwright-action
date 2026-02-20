import React from "react"
import { JSX, useState, useEffect } from "react"
import { api, Note, CreateNoteInput, UpdateNoteInput } from "../services/api"

export function Home(): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [formTitle, setFormTitle] = useState("")
  const [formBody, setFormBody] = useState("")
  const [formTags, setFormTags] = useState("")
  const [isEditing, setIsEditing] = useState(false)
  const [savedIds, setSavedIds] = useState<number[]>([])

  useEffect(() => {
    const saved = localStorage.getItem("noteIds")
    if (saved) {
      setSavedIds(JSON.parse(saved) as number[])
    }
  }, [])

  const saveNoteId = (id: number) => {
    const updated = [...savedIds]
    if (!updated.includes(id)) {
      updated.push(id)
      setSavedIds(updated)
      localStorage.setItem("noteIds", JSON.stringify(updated))
    }
  }

  const removeNoteId = (id: number) => {
    const updated = savedIds.filter(nid => nid !== id)
    setSavedIds(updated)
    localStorage.setItem("noteIds", JSON.stringify(updated))
  }

  const loadNote = async (id: number) => {
    setLoading(true)
    setError(null)
    try {
      const note = await api.getNote(id)
      setSelectedNote(note)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load note")
    } finally {
      setLoading(false)
    }
  }

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const tags = formTags
        .split(",")
        .map(t => t.trim())
        .filter(t => t)
      const input: CreateNoteInput = {
        title: formTitle,
        body: formBody,
        tags,
      }

      const note = await api.createNote(input)
      setNotes([...notes, note])
      saveNoteId(note.id)
      setSelectedNote(null)
      setIsEditing(false)
      setFormTitle("")
      setFormBody("")
      setFormTags("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create note")
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateNote = async () => {
    if (!selectedNote) return

    setLoading(true)
    setError(null)

    try {
      const tags = formTags
        .split(",")
        .map(t => t.trim())
        .filter(t => t)
      const input: UpdateNoteInput = {
        title: formTitle,
        body: formBody,
        tags,
        archived: selectedNote.archived,
      }

      const updated = await api.updateNote(selectedNote.id, input)
      setSelectedNote(updated)
      setNotes(notes.map(n => (n.id === updated.id ? updated : n)))
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update note")
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteNote = async () => {
    if (!selectedNote) return

    if (!confirm("Are you sure you want to delete this note?")) return

    setLoading(true)
    setError(null)

    try {
      await api.deleteNote(selectedNote.id)
      removeNoteId(selectedNote.id)
      setNotes(notes.filter(n => n.id !== selectedNote.id))
      setSelectedNote(null)
      setIsEditing(false)
      setFormTitle("")
      setFormBody("")
      setFormTags("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete note")
    } finally {
      setLoading(false)
    }
  }

  const startEdit = () => {
    if (selectedNote) {
      setFormTitle(selectedNote.title)
      setFormBody(selectedNote.body)
      setFormTags(selectedNote.tags.join(", "))
      setIsEditing(true)
    }
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setSelectedNote(null)
    setFormTitle("")
    setFormBody("")
    setFormTags("")
  }

  useEffect(() => {
    if (selectedNote && !isEditing) {
      setFormTitle(selectedNote.title)
      setFormBody(selectedNote.body)
      setFormTags(selectedNote.tags.join(", "))
    } else if (!selectedNote) {
      setFormTitle("")
      setFormBody("")
      setFormTags("")
      setIsEditing(false)
    }
  }, [selectedNote, isEditing])

  return (
    <div className="w-full p-6">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-6">
        Note Taking App
      </h1>

      {error && (
        <div className="mb-4 p-4 bg-red-100 dark:bg-red-900 border border-red-400 text-red-700 dark:text-red-200 rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
              {isEditing ? "Edit Note" : "Create New Note"}
            </h2>

            <form
              onSubmit={
                isEditing
                  ? e => {
                      e.preventDefault()
                      handleUpdateNote().catch(err => {
                        console.error("Update note error:", err)
                      })
                    }
                  : handleCreateNote
              }
            >
              <div className="mb-4">
                <label htmlFor="note-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Title
                </label>
                <input
                  id="note-title"
                  type="text"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
              </div>

              <div className="mb-4">
                <label htmlFor="note-body" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Body
                </label>
                <textarea
                  id="note-body"
                  value={formBody}
                  onChange={e => setFormBody(e.target.value)}
                  required
                  rows={8}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
              </div>

              <div className="mb-4">
                <label htmlFor="note-tags" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Tags (comma-separated)
                </label>
                <input
                  id="note-tags"
                  type="text"
                  value={formTags}
                  onChange={e => setFormTags(e.target.value)}
                  placeholder="tag1, tag2, tag3"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                />
              </div>

              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    <button
                      type="submit"
                      disabled={loading}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                    >
                      {loading ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={loading}
                      className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-md hover:bg-gray-400 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleDeleteNote().catch(err => {
                          console.error("Delete note error:", err)
                        })
                      }}
                      disabled={loading}
                      className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 ml-auto"
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                  >
                    {loading ? "Creating..." : "Create Note"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
              Your Notes ({savedIds.length})
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {savedIds.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                  No notes yet
                </p>
              ) : (
                savedIds.map(id => (
                  <button
                    key={id}
                    onClick={() => {
                      loadNote(id).catch(err => {
                        console.error("Load note error:", err)
                      })
                    }}
                    className="w-full text-left px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-sm text-gray-900 dark:text-white"
                  >
                    Note #{id}
                  </button>
                ))
              )}
            </div>
          </div>

          {selectedNote && !isEditing && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Note Details
                </h3>
                <button
                  onClick={startEdit}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Edit
                </button>
              </div>
              <div className="space-y-2 text-sm">
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">ID:</span> {selectedNote.id}
                </p>
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">Title:</span>{" "}
                  {selectedNote.title}
                </p>
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">Body:</span> {selectedNote.body}
                </p>
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">Tags:</span>{" "}
                  {selectedNote.tags.join(", ") || "None"}
                </p>
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">Archived:</span>{" "}
                  {selectedNote.archived ? "Yes" : "No"}
                </p>
                <p className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium">Updated:</span>{" "}
                  {new Date(selectedNote.updated_at).toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
