import React from 'react'
import type { ThemePreference } from '../../../../shared/contracts.ts'

interface AppearanceProps {
  currentTheme: ThemePreference
  isLoading: boolean
  isSaving: boolean
  errorMessage: string | null
  headingRef: React.RefObject<HTMLHeadingElement | null>
  onThemeSelect: (theme: ThemePreference) => void
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow the operating system appearance and automatic changes.'
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Use the light canvas and high-contrast dark text.'
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Use the dark canvas and muted surface styling.'
  }
]

export const Appearance: React.FC<AppearanceProps> = ({
  currentTheme,
  isLoading,
  isSaving,
  errorMessage,
  headingRef,
  onThemeSelect
}) => {
  const isDisabled = isLoading || isSaving

  return (
    <div className="view-content">
      <h1 id="appearance-heading" ref={headingRef} tabIndex={-1} className="view-title">
        Appearance
      </h1>

      <div className="preference-section">
        <p className="section-caption">
          Select how Kazaa looks to you. Choose System to synchronize with your OS settings.
        </p>

        <fieldset className="radio-group" disabled={isDisabled} aria-label="Appearance options">
          {THEME_OPTIONS.map((option) => {
            const isSelected = currentTheme === option.value
            return (
              <label
                key={option.value}
                className={`radio-card ${isSelected ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="theme-preference"
                  value={option.value}
                  checked={isSelected}
                  disabled={isDisabled}
                  onChange={() => onThemeSelect(option.value)}
                />
                <div className="radio-text-container">
                  <span className="radio-label-text">{option.label}</span>
                </div>
              </label>
            )
          })}
        </fieldset>

        {errorMessage && (
          <div className="alert-banner" role="alert">
            {errorMessage}
          </div>
        )}
      </div>
    </div>
  )
}
