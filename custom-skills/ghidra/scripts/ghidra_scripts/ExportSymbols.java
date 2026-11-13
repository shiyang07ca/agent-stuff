/* ###
 * 导出全部符号及其地址
 * @category Export
 */

import ghidra.app.script.GhidraScript;
import ghidra.program.model.symbol.*;
import ghidra.program.model.listing.*;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;

public class ExportSymbols extends GhidraScript {

    @Override
    public void run() throws Exception {
        String outputDir = System.getenv("GHIDRA_OUTPUT_DIR");
        if (outputDir == null || outputDir.isEmpty()) {
            outputDir = ".";
        }

        String programName = currentProgram.getName().replaceAll("[^a-zA-Z0-9._-]", "_");
        File outputFile = new File(outputDir, programName + "_symbols.json");

        println("Exporting symbols to: " + outputFile.getAbsolutePath());

        SymbolTable symbolTable = currentProgram.getSymbolTable();

        try (PrintWriter writer = new PrintWriter(new FileWriter(outputFile))) {
            writer.println("{");
            writer.println("  \"program\": \"" + escapeJson(currentProgram.getName()) + "\",");

            // 导出 imports（外部函数）
            writer.println("  \"imports\": [");
            boolean first = true;
            int importCount = 0;
            SymbolIterator externalSymbols = symbolTable.getExternalSymbols();
            while (externalSymbols.hasNext() && !monitor.isCancelled()) {
                Symbol sym = externalSymbols.next();
                if (!first) writer.println(",");
                first = false;
                writer.println("    {");
                writer.println("      \"name\": \"" + escapeJson(sym.getName()) + "\",");
                writer.println("      \"address\": \"" + sym.getAddress() + "\",");
                writer.println("      \"namespace\": \"" + escapeJson(sym.getParentNamespace().getName()) + "\",");
                writer.println("      \"type\": \"" + sym.getSymbolType() + "\"");
                writer.print("    }");
                importCount++;
            }
            writer.println();
            writer.println("  ],");

            // 导出 exports（如有）
            writer.println("  \"exports\": [");
            first = true;
            int exportCount = 0;
            // 可能是 export symbol 的函数（entry point 或已 export）
            FunctionIterator functions = currentProgram.getFunctionManager().getExternalFunctions();
            // 查找标记为 entry point 的函数
            FunctionIterator allFunctions = currentProgram.getFunctionManager().getFunctions(true);
            while (allFunctions.hasNext() && !monitor.isCancelled()) {
                Function func = allFunctions.next();
                // 检查函数是否位于 entry point，或具有 export symbol
                Symbol sym = func.getSymbol();
                if (sym.isExternalEntryPoint() || sym.getSource() == SourceType.IMPORTED) {
                    if (!first) writer.println(",");
                    first = false;
                    writer.println("    {");
                    writer.println("      \"name\": \"" + escapeJson(func.getName()) + "\",");
                    writer.println("      \"address\": \"" + func.getEntryPoint() + "\",");
                    writer.println("      \"signature\": \"" + escapeJson(func.getPrototypeString(false, false)) + "\"");
                    writer.print("    }");
                    exportCount++;
                }
            }
            writer.println();
            writer.println("  ],");

            // 导出全部 label/符号
            writer.println("  \"symbols\": [");
            first = true;
            int symbolCount = 0;
            SymbolIterator allSymbols = symbolTable.getAllSymbols(true);
            while (allSymbols.hasNext() && !monitor.isCancelled()) {
                Symbol sym = allSymbols.next();
                // 跳过默认/动态符号以减少噪声
                if (sym.getSource() == SourceType.DEFAULT) {
                    continue;
                }

                if (!first) writer.println(",");
                first = false;
                writer.println("    {");
                writer.println("      \"name\": \"" + escapeJson(sym.getName()) + "\",");
                writer.println("      \"address\": \"" + sym.getAddress() + "\",");
                writer.println("      \"type\": \"" + sym.getSymbolType() + "\",");
                writer.println("      \"source\": \"" + sym.getSource() + "\",");
                writer.println("      \"namespace\": \"" + escapeJson(sym.getParentNamespace().getName()) + "\",");
                writer.println("      \"primary\": " + sym.isPrimary());
                writer.print("    }");
                symbolCount++;

                // 限制输出以避免体积过大
                if (symbolCount >= 10000) {
                    writer.println(",");
                    writer.println("    {\"_truncated\": true, \"_message\": \"Output truncated at 10000 symbols\"}");
                    break;
                }
            }
            writer.println();
            writer.println("  ],");

            // 摘要
            writer.println("  \"summary\": {");
            writer.println("    \"imports\": " + importCount + ",");
            writer.println("    \"exports\": " + exportCount + ",");
            writer.println("    \"symbols\": " + symbolCount);
            writer.println("  }");

            writer.println("}");

            println("Exported " + importCount + " imports, " + exportCount + " exports, and " + symbolCount + " symbols");
        }
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
