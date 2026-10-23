"""Mikka-owned disposable GTK editor fixture; no upstream CUA source."""
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Pango
window = Gtk.Window(title='Mikka isolated CI editor')
window.set_default_size(900, 600)
view = Gtk.TextView()
view.set_left_margin(32)
view.set_top_margin(40)
view.modify_font(Pango.FontDescription('Monospace 28'))
window.add(view)
window.connect('destroy', Gtk.main_quit)
window.show_all()
view.grab_focus()
window.present()
Gtk.main()
