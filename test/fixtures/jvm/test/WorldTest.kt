import kotlin.test.Test
import kotlin.test.assertEquals

class WorldTest {
    @Test
    fun returnsWorld() {
        assertEquals("World", World.get())
    }
}
