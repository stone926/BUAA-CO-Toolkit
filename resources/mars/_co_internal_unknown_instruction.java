import mars.ProcessingException;
import mars.ProgramStatement;
import mars.mips.instructions.InstructionLoad;
import mars.simulator.Exceptions;

public class _co_internal_unknown_instruction implements InstructionLoad {
    @Override
    public void simulate(ProgramStatement statement) throws ProcessingException {
        throw new ProcessingException(statement, "reserved instruction", Exceptions.RESERVED_INSTRUCTION_EXCEPTION);
    }

    @Override
    public String getTemplate() {
        return "_co_internal_unknown_instruction";
    }

    @Override
    public String getFormatStr() {
        return "R";
    }

    @Override
    public String getDescription() {
        return "BUAA CO internal reserved instruction test";
    }

    @Override
    public String getEncoding() {
        return "000000 00000 00000 00000 00000 111111";
    }
}
