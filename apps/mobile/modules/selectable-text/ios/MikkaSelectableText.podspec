Pod::Spec.new do |s|
  s.name           = 'MikkaSelectableText'
  s.version        = '1.0.0'
  s.summary        = 'A chat message selectable in place, with 添加到对话 in the system edit menu.'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Mikka'
  s.homepage       = 'https://github.com/alexj11324/Mikka'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
