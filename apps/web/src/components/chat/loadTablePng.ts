export const loadTablePng = (table: HTMLTableElement) =>
  import("./tablePng").then((module) => module.renderTablePng(table));
