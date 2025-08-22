// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  ChangelogSection,
  ChangelogNotes,
  BuildNotesOptions,
} from '../changelog-notes';
import {ConventionalCommit} from '../commit';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conventionalChangelogWriter = require('conventional-changelog-writer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const presetFactory = require('conventional-changelog-conventionalcommits');
const DEFAULT_HOST = 'https://github.com';

interface DefaultChangelogNotesOptions {
  commitPartial?: string;
  headerPartial?: string;
  mainTemplate?: string;
}

interface Note {
  title: string;
  text: string;
}

export class DefaultChangelogNotes implements ChangelogNotes {
  // allow for customized commit template.
  private commitPartial?: string;
  private headerPartial?: string;
  private mainTemplate?: string;

  constructor(options: DefaultChangelogNotesOptions = {}) {
    this.commitPartial = options.commitPartial;
    this.headerPartial = options.headerPartial;
    this.mainTemplate = options.mainTemplate;
  }

  async buildNotes(
    commits: ConventionalCommit[],
    options: BuildNotesOptions
  ): Promise<string> {
    const context = {
      host: options.host || DEFAULT_HOST,
      owner: options.owner,
      repository: options.repository,
      version: options.version,
      previousTag: options.previousTag,
      currentTag: options.currentTag,
      linkCompare: !!options.previousTag,
    };

    const config: {[key: string]: ChangelogSection[]} = {};
    if (options.changelogSections) {
      config.types = options.changelogSections;
    }
    const preset = await presetFactory(config);
    preset.writerOpts.commitPartial =
      this.commitPartial || preset.writerOpts.commitPartial;
    preset.writerOpts.headerPartial =
      this.headerPartial || preset.writerOpts.headerPartial;
    preset.writerOpts.mainTemplate =
      this.mainTemplate || preset.writerOpts.mainTemplate;
    const trackerList = (options as any).trackerList as string | undefined;
    const trackerPrefixes = trackerList
      ? trackerList.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const prefixClass = trackerPrefixes && trackerPrefixes.length
      ? `(?:${trackerPrefixes.map(p => p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})`
      : '[A-Z][A-Z0-9]+';
    const jiraHeader = new RegExp(`^(\\[${prefixClass}-\\d+\\]|${prefixClass}-\\d+):\\s`);
    const jiraKeyExtract = new RegExp(`^(?:\\[)?(${prefixClass}-\\d+)(?:\\])?:\\s(.*)$`);
    const changelogCommits = commits.map(commit => {
      const notes = commit.notes
        .filter(note => note.title === 'BREAKING CHANGE')
        .map(note =>
          replaceIssueLink(
            note,
            context.host,
            context.owner,
            context.repository
          )
        );
      const headerLine = commit.message;
      const isJiraHeader = jiraHeader.test(headerLine);
      let subject = htmlEscape(commit.bareMessage);
      if (isJiraHeader) {
        // Replace JIRA key with external tracker link if configured
        const m = headerLine.match(jiraKeyExtract);
        if (m) {
          const key = m[1];
          const rest = m[2];
          if ((options as any).trackerUrl) {
            const tracker = (options as any).trackerUrl as string;
            subject = `[${key}](${tracker.replace(/\/?$/, '/')}${key}): ${htmlEscape(rest)}`;
          } else {
            subject = htmlEscape(headerLine);
          }
        } else {
          subject = htmlEscape(headerLine);
        }
      }
      const type = isJiraHeader ? 'others' : commit.type;
      return {
        body: '', // commit.body,
        subject,
        type,
        scope: commit.scope,
        notes,
        references: commit.references,
        mentions: [],
        merge: null,
        revert: null,
        header: commit.message,
        footer: commit.notes
          .filter(note => note.title === 'RELEASE AS')
          .map(note => `Release-As: ${note.text}`)
          .join('\n'),
        hash: commit.sha,
      };
    });

    const rendered = conventionalChangelogWriter
      .parseArray(changelogCommits, context, preset.writerOpts)
      .trim();

    // Writer sometimes renders только заголовок выпуска без секций.
    const hasSectionsOrBullets = /\n###\s|\n\*\s/.test(rendered);
    if (rendered.length > 0 && hasSectionsOrBullets) return rendered;

    // Fallback: если writer вернул пусто (или только заголовок), а Others есть — дорисуем вручную
    const others = changelogCommits.filter(c => c.type === 'others');
    if (others.length > 0) {
      const lines: string[] = [];
      // Сохраняем заголовок версии, если writer его сгенерировал:
      if (rendered.length > 0 && !hasSectionsOrBullets) {
        lines.push(rendered);
        lines.push('');
      }
      lines.push('### Others');
      lines.push('');
      for (const c of others) {
        const shortSha = (c as any).hash || '';
        const sha7 = shortSha ? String(shortSha).slice(0, 7) : '';
        const link = sha7
          ? `([${sha7}](${context.host}/${context.owner}/${context.repository}/commit/${shortSha}))`
          : '';
        lines.push(`* ${c.subject} ${link}`.trim());
      }
      return lines.join('\n');
    }

    return rendered;
  }
}

function replaceIssueLink(
  note: Note,
  host: string,
  owner: string,
  repo: string
): Note {
  note.text = note.text.replace(
    /\(#(\d+)\)/,
    `([#$1](${host}/${owner}/${repo}/issues/$1))`
  );
  return note;
}

function htmlEscape(message: string): string {
  return message.replace(/``[^`].*[^`]``|`[^`]*`|<|>/g, match =>
    match.length > 1 ? match : match === '<' ? '&lt;' : '&gt;'
  );
}
