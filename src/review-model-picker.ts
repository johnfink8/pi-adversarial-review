/**
 * The `/review-model` selector: a search-backed overlay in the shape of pi's
 * own model/thinking selectors (Input + fuzzy-filtered SelectList inside a
 * custom component), so picking from a long registry behaves like `/model`.
 */

import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

/** SelectList windows itself above this many rows and draws its scroll indicator. */
const MAX_VISIBLE = 10;
const LIST_LAYOUT = { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 48 };

/** The clear entry's value. Contains no "/" so no registry id can collide with it. */
export const CLEAR_MODEL_VALUE = "clear";

export type ReviewModelChoice = { kind: "clear" } | { kind: "model"; value: string };

export function toReviewModelChoice(value: string): ReviewModelChoice {
  return value === CLEAR_MODEL_VALUE ? { kind: "clear" } : { kind: "model", value };
}

export interface ReviewModelOption {
  value: string;
  label: string;
  description?: string;
}

export function buildModelOptions(
  models: readonly { provider: string; id: string; name?: string | undefined }[],
): ReviewModelOption[] {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.id}`,
    ...(model.name !== undefined && model.name !== model.id ? { description: model.name } : {}),
  }));
}

export class ReviewModelSelector extends Container {
  private readonly searchInput = new Input();
  private selectList: SelectList;
  private readonly selectListChildIndex: number;
  private readonly allItems: SelectItem[];
  private _focused = false;

  constructor(
    current: string | undefined,
    options: ReviewModelOption[],
    private readonly onSelect: (value: string) => void,
    private readonly onCancel: () => void,
  ) {
    super();
    this.allItems = options.map((option) => ({
      value: option.value,
      label: `${option.value === current ? "✓" : " "} ${option.label}`,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));

    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text("Panel model for this session", 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.searchInput.onSubmit = () => this.confirm();
    this.addChild(new Spacer(1));

    const list = this.buildList(this.allItems, current);
    this.selectList = list;
    this.selectListChildIndex = this.children.length;
    this.addChild(list);

    this.addChild(new Spacer(1));
    this.addChild(new Text("  type to search · enter to select · esc to cancel", 0, 0));
    this.addChild(new DynamicBorder());
  }

  /** pi-tui requires containers wrapping an Input to forward focus (IME cursor placement). */
  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private confirm(): void {
    const item = this.selectList.getSelectedItem();
    if (item !== null) this.onSelect(item.value);
  }

  private buildList(items: SelectItem[], preselect: string | undefined): SelectList {
    const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), LIST_LAYOUT);
    const index = items.findIndex((item) => item.value === preselect);
    if (index !== -1) list.setSelectedIndex(index);
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = () => this.onCancel();
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`)
      : this.allItems;
    const selected = this.selectList.getSelectedItem()?.value;
    const list = this.buildList(filtered, selected);
    this.children[this.selectListChildIndex] = list;
    this.selectList = list;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    const isNav =
      kb.matches(keyData, "tui.select.up") ||
      kb.matches(keyData, "tui.select.down") ||
      kb.matches(keyData, "tui.select.confirm") ||
      kb.matches(keyData, "tui.select.cancel");
    if (isNav) {
      this.selectList.handleInput(keyData);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }
}
